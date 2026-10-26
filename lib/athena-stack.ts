import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';
import { logRetention } from './common/utils/retention';

export interface PortfolioAthenaStackProps extends cdk.StackProps {
  /** Real domain name, read from cdk.json context (gitignored); used only to name the results bucket */
  domainName: string;
  /** Physical-resource-name prefix (bin/app.ts) */
  projectSlug: string;
  /** Logging bucket name, passed from PortfolioStorageStack (same value PortfolioCDNStack receives) */
  loggingBucketName: string;
  /**
   * ARN of the AWS-managed "AWS SDK for pandas" Lambda layer (includes pyarrow)
   * for this account's region and Python 3.12. Look this up rather than trust a
   * hardcoded version: AWS periodically publishes new layer versions and an old
   * one can be deprecated.
   *   Lambda console -> Layers -> "Add a layer" -> AWS layers ->
   *   search "AWSSDKPandas-Python312" -> copy the ARN shown for your region.
   * Set as `pandasLayerArn` in cdk.json context.
   */
  pandasLayerArn: string;
  /** The app-wide retention period (bin/app.ts), for this stack's Lambda log groups */
  retentionDays: number;
}

/**
 * PortfolioAthenaStack
 *
 * Athena/Glue resources to query the CloudFront access logs that
 * PortfolioStorageStack's logging bucket receives under cloudfront-logs/.
 *
 * This stack does NOT touch the logging bucket's lifecycle rules or the
 * BucketDeployment in PortfolioCDNStack. It only reads from the existing bucket
 * through an imported reference.
 */
export class PortfolioAthenaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PortfolioAthenaStackProps) {
    super(scope, id, props);

    const { domainName, projectSlug, loggingBucketName, retentionDays } = props;
    // Glue/Hive database names allow only lowercase letters, digits, and
    // underscores, so this variant is used for the database name.
    const glueSlug = projectSlug.replace(/-/g, '_');
    // Self-identified bots and scripts, for the saved queries below. If the
    // ETL email ever classifies user agents, reuse this same list there.
    const botUserAgentPattern = 'bot|spider|crawl|curl|wget|python-requests|headlesschrome|facebookexternalhit|semrush|ahrefs';

    // Dedicated bucket for Athena's own query result files, kept separate from
    // the CloudFront logs so nothing here interacts with the logs' lifecycle rule.
    const athenaResultsBucket = new s3.Bucket(this, 'AthenaResultsBucket', {
      bucketName: `${domainName}-athena-results`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [
        {
          id: 'expire-query-results',
          // Scratch files, cheap to regenerate; their own period, not retentionDays
          expiration: cdk.Duration.days(30),
        },
      ],
      // Query-result files are safe to clean up fully if the stack is torn down
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // autoDeleteObjects adds a CDK helper Lambda that empties the bucket if the
    // stack is ever deleted. CDK doesn't offer a log setting for it, so its
    // logging config is set directly: without this, Lambda creates a log group
    // on first run that never expires. bin/app.ts fails synth if any Lambda
    // lacks a log group.
    const autoDeleteLogGroup = new logs.LogGroup(this, 'AutoDeleteObjectsLogs', {
      logGroupName: `/aws/lambda/${projectSlug}-cdk-athena-results-cleanup`,
      retention: logRetention(retentionDays),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const autoDeleteProvider = this.node.tryFindChild('Custom::S3AutoDeleteObjectsCustomResourceProvider');
    const autoDeleteHandler = autoDeleteProvider?.node.tryFindChild('Handler') as cdk.CfnResource | undefined;
    if (!autoDeleteHandler) {
      throw new Error('CDK auto-delete helper Lambda not found; its construct path may have changed in a CDK upgrade. Update this lookup in athena-stack.ts.');
    }
    autoDeleteHandler.addPropertyOverride('LoggingConfig', { LogGroup: autoDeleteLogGroup.logGroupName });

    // Glue database Athena queries against
    const database = new glue.CfnDatabase(this, 'PortfolioLogsDatabase', {
      catalogId: this.account,
      databaseInput: {
        name: `${glueSlug}_logs`,
        description: `Database for ${projectSlug} CloudFront access logs`,
      },
    });

    // Table schema matches the CloudFront standard log format: tab-delimited,
    // 33 columns, 2 header lines (#Version, #Fields) to skip, gzip files read
    // transparently by TextInputFormat.
    const cloudfrontLogsTable = new glue.CfnTable(this, 'CloudFrontLogsTable', {
      catalogId: this.account,
      databaseName: database.ref,
      tableInput: {
        name: 'cloudfront_logs',
        description: 'Raw CloudFront distribution access logs',
        tableType: 'EXTERNAL_TABLE',
        parameters: {
          EXTERNAL: 'TRUE',
          'skip.header.line.count': '2',
        },
        storageDescriptor: {
          location: `s3://${loggingBucketName}/cloudfront-logs/`,
          inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          serdeInfo: {
            serializationLibrary: 'org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe',
            parameters: {
              'field.delim': '\t',
              'serialization.format': '\t',
            },
          },
          columns: [
            { name: 'date', type: 'date' },
            { name: 'time', type: 'string' },
            { name: 'x_edge_location', type: 'string' },
            { name: 'sc_bytes', type: 'bigint' },
            { name: 'c_ip', type: 'string' },
            { name: 'cs_method', type: 'string' },
            { name: 'cs_host', type: 'string' },
            { name: 'cs_uri_stem', type: 'string' },
            { name: 'sc_status', type: 'string' },
            { name: 'cs_referer', type: 'string' },
            { name: 'cs_user_agent', type: 'string' },
            { name: 'cs_uri_query', type: 'string' },
            { name: 'cs_cookie', type: 'string' },
            { name: 'x_edge_result_type', type: 'string' },
            { name: 'x_edge_request_id', type: 'string' },
            { name: 'x_host_header', type: 'string' },
            { name: 'cs_protocol', type: 'string' },
            { name: 'cs_bytes', type: 'bigint' },
            { name: 'time_taken', type: 'double' },
            { name: 'x_forwarded_for', type: 'string' },
            { name: 'ssl_protocol', type: 'string' },
            { name: 'ssl_cipher', type: 'string' },
            { name: 'x_edge_response_result_type', type: 'string' },
            { name: 'cs_protocol_version', type: 'string' },
            { name: 'fle_status', type: 'string' },
            { name: 'fle_encrypted_fields', type: 'string' },
            { name: 'c_port', type: 'int' },
            { name: 'time_to_first_byte', type: 'double' },
            { name: 'x_edge_detailed_result_type', type: 'string' },
            { name: 'sc_content_type', type: 'string' },
            { name: 'sc_content_len', type: 'bigint' },
            { name: 'sc_range_start', type: 'bigint' },
            { name: 'sc_range_end', type: 'bigint' },
          ],
        },
      },
    });
    cloudfrontLogsTable.addResourceDependency(database);

    // Workgroup pins query results to the dedicated bucket and caps scanned bytes per query
    const workgroup = new athena.CfnWorkGroup(this, 'PortfolioAthenaWorkgroup', {
      name: `${projectSlug}-logs`,
      description: `Workgroup for querying ${projectSlug} CloudFront logs`,
      state: 'ENABLED',
      workGroupConfiguration: {
        resultConfiguration: {
          outputLocation: `s3://${athenaResultsBucket.bucketName}/query-results/`,
        },
        enforceWorkGroupConfiguration: true,
        publishCloudWatchMetricsEnabled: true,
        bytesScannedCutoffPerQuery: 1_000_000_000, // 1 GB safety cap per query; logs are small
      },
    });

    // Saved queries, ready to run from the Athena console (Saved queries tab)
    const savedQuery = (logicalId: string, name: string, description: string, queryString: string) => {
      const query = new athena.CfnNamedQuery(this, logicalId, {
        database: database.ref,
        workGroup: workgroup.name,
        name,
        description,
        queryString: queryString.trim(),
      });
      query.addResourceDependency(workgroup);
    };

    savedQuery('TopPagesQuery', 'top-pages-last-7-days',
      'Most-requested URI paths in the last 7 days',
      `
SELECT cs_uri_stem, COUNT(*) AS requests
FROM cloudfront_logs
WHERE "date" >= date_add('day', -7, current_date)
GROUP BY cs_uri_stem
ORDER BY requests DESC
LIMIT 25;
`);

    // User-agent split only. Most scanners send ordinary browser user agents,
    // so "other" is NOT a count of people.
    savedQuery('BotVsOtherQuery', 'bot-user-agents-vs-other',
      'Requests from self-identified bot/crawler user agents vs everything else (not a visitor count)',
      `
SELECT
  CASE
    WHEN regexp_like(lower(cs_user_agent), '${botUserAgentPattern}')
    THEN 'bot_user_agent'
    ELSE 'other'
  END AS traffic_type,
  COUNT(*) AS requests,
  COUNT(DISTINCT c_ip) AS distinct_ips
FROM cloudfront_logs
GROUP BY 1
ORDER BY requests DESC;
`);

    // An IP count, not visitors: it includes every scanner and crawler.
    savedQuery('TrafficByDayQuery', 'traffic-by-day',
      'Daily request volume and distinct client IPs, all traffic including bots (not a visitor count)',
      `
SELECT
  "date",
  COUNT(*) AS requests,
  COUNT(DISTINCT c_ip) AS unique_ips
FROM cloudfront_logs
GROUP BY "date"
ORDER BY "date" DESC;
`);

    savedQuery('StatusCodeBreakdownQuery', 'status-code-breakdown',
      'Request counts grouped by HTTP status code',
      `
SELECT sc_status, COUNT(*) AS requests
FROM cloudfront_logs
GROUP BY sc_status
ORDER BY requests DESC;
`);

    savedQuery('ReferrerBreakdownQuery', 'top-referrers',
      'Where traffic is coming from, excluding direct/empty referrers',
      `
SELECT cs_referer, COUNT(*) AS requests
FROM cloudfront_logs
WHERE cs_referer != '-'
GROUP BY cs_referer
ORDER BY requests DESC
LIMIT 25;
`);

    // ---------------------------------------------------------------------
    // Optimized, partitioned table: Parquet under cloudfront-logs-optimized/
    // in the same logging bucket. The ETL Lambda below populates it and
    // registers each day's partition; no Glue Crawler is needed, since the
    // Lambda knows the exact partition values it just wrote.
    // ---------------------------------------------------------------------
    const optimizedTable = new glue.CfnTable(this, 'CloudFrontLogsOptimizedTable', {
      catalogId: this.account,
      databaseName: database.ref,
      tableInput: {
        name: 'cloudfront_logs_optimized',
        description: `Parquet, partitioned CloudFront logs - populated daily by ${projectSlug}-log-etl`,
        tableType: 'EXTERNAL_TABLE',
        parameters: { EXTERNAL: 'TRUE' },
        partitionKeys: [
          { name: 'year', type: 'string' },
          { name: 'month', type: 'string' },
          { name: 'day', type: 'string' },
        ],
        storageDescriptor: {
          location: `s3://${loggingBucketName}/cloudfront-logs-optimized/`,
          inputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
          serdeInfo: {
            serializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe',
          },
          // Same 33 columns as cloudfront_logs, minus the partition keys. date is
          // 'string' here (not 'date') and c_port is 'bigint' (not 'int') because
          // that's what the ETL Lambda's pandas dtype map writes to Parquet, and
          // Parquet's strict physical-type checking rejects any mismatch.
          columns: [
            { name: 'date', type: 'string' },
            { name: 'time', type: 'string' },
            { name: 'x_edge_location', type: 'string' },
            { name: 'sc_bytes', type: 'bigint' },
            { name: 'c_ip', type: 'string' },
            { name: 'cs_method', type: 'string' },
            { name: 'cs_host', type: 'string' },
            { name: 'cs_uri_stem', type: 'string' },
            { name: 'sc_status', type: 'string' },
            { name: 'cs_referer', type: 'string' },
            { name: 'cs_user_agent', type: 'string' },
            { name: 'cs_uri_query', type: 'string' },
            { name: 'cs_cookie', type: 'string' },
            { name: 'x_edge_result_type', type: 'string' },
            { name: 'x_edge_request_id', type: 'string' },
            { name: 'x_host_header', type: 'string' },
            { name: 'cs_protocol', type: 'string' },
            { name: 'cs_bytes', type: 'bigint' },
            { name: 'time_taken', type: 'double' },
            { name: 'x_forwarded_for', type: 'string' },
            { name: 'ssl_protocol', type: 'string' },
            { name: 'ssl_cipher', type: 'string' },
            { name: 'x_edge_response_result_type', type: 'string' },
            { name: 'cs_protocol_version', type: 'string' },
            { name: 'fle_status', type: 'string' },
            { name: 'fle_encrypted_fields', type: 'string' },
            { name: 'c_port', type: 'bigint' },
            { name: 'time_to_first_byte', type: 'double' },
            { name: 'x_edge_detailed_result_type', type: 'string' },
            { name: 'sc_content_type', type: 'string' },
            { name: 'sc_content_len', type: 'bigint' },
            { name: 'sc_range_start', type: 'bigint' },
            { name: 'sc_range_end', type: 'bigint' },
          ],
        },
      },
    });
    optimizedTable.addResourceDependency(database);

    // ---------------------------------------------------------------------
    // ETL Lambda: converts yesterday's raw logs to Parquet, registers the
    // partition, queries its own output for a daily summary, and emails it
    // through the verified SES domain.
    // ---------------------------------------------------------------------
    const pandasLayer = lambda.LayerVersion.fromLayerVersionArn(this, 'PandasLayer', props.pandasLayerArn);

    const etlRole = new iam.Role(this, 'LogEtlRole', {
      roleName: `${projectSlug}-log-etl-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Read raw logs, write optimized logs: same bucket, two prefixes, each scoped
    const loggingBucketForGrants = s3.Bucket.fromBucketName(this, 'ImportedLoggingBucketForEtl', loggingBucketName);
    loggingBucketForGrants.grantRead(etlRole, 'cloudfront-logs/*');
    loggingBucketForGrants.grantReadWrite(etlRole, 'cloudfront-logs-optimized/*');

    // Athena's StartQueryExecution also needs bucket-level s3:GetBucketLocation
    // and s3:ListBucket on the output bucket, or it fails with "Unable to
    // verify/create output bucket". Object-level grants alone aren't enough.
    etlRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        's3:GetBucketLocation',
        's3:ListBucket',
        's3:GetObject',
        's3:PutObject',
        's3:ListBucketMultipartUploads',
        's3:ListMultipartUploadParts',
        's3:AbortMultipartUpload',
      ],
      resources: [
        athenaResultsBucket.bucketArn,
        `${athenaResultsBucket.bucketArn}/*`,
      ],
    }));

    etlRole.addToPolicy(new iam.PolicyStatement({
      actions: ['athena:StartQueryExecution', 'athena:GetQueryExecution', 'athena:GetQueryResults'],
      resources: [`arn:aws:athena:${this.region}:${this.account}:workgroup/${workgroup.name}`],
    }));

    etlRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'glue:GetDatabase', 'glue:GetTable', 'glue:GetPartition', 'glue:GetPartitions',
        'glue:BatchCreatePartition', 'glue:CreatePartition',
      ],
      resources: [
        `arn:aws:glue:${this.region}:${this.account}:catalog`,
        `arn:aws:glue:${this.region}:${this.account}:database/${database.ref}`,
        `arn:aws:glue:${this.region}:${this.account}:table/${database.ref}/${optimizedTable.ref}`,
      ],
    }));

    // SES send permission. Resource '*' because SES v1 SendEmail isn't scoped
    // to an identity ARN here.
    etlRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: ['*'],
    }));

    etlRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/${projectSlug}/alert-email`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/${projectSlug}/contact-email-from`,
      ],
    }));

    // Explicit log group with retentionDays, matching the contact Lambda
    // (api-stack.ts). Without it, Lambda creates /aws/lambda/<name> on first run
    // with no expiry. In an account where that auto-created group already
    // exists, it must be deleted before the first deploy that adds this, or
    // CloudFormation fails with "already exists".
    const etlLogGroup = new logs.LogGroup(this, 'LogEtlFunctionLogs', {
      logGroupName: `/aws/lambda/${projectSlug}-log-etl`,
      retention: logRetention(retentionDays),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const etlFunction = new lambda.Function(this, 'LogEtlFunction', {
      functionName: `${projectSlug}-log-etl`,
      description: 'Converts previous day\'s CloudFront logs to partitioned Parquet and emails a traffic summary',
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.X86_64, // must match the pandas layer's architecture
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'log-etl')),
      layers: [pandasLayer],
      role: etlRole,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      logGroup: etlLogGroup,
      environment: {
        LOG_BUCKET: loggingBucketName,
        RAW_PREFIX: 'cloudfront-logs/',
        OPTIMIZED_PREFIX: 'cloudfront-logs-optimized/',
        GLUE_DATABASE: database.ref,
        OPTIMIZED_TABLE: 'cloudfront_logs_optimized',
        ATHENA_WORKGROUP: workgroup.name!,
        RESULTS_BUCKET: athenaResultsBucket.bucketName,
        ALERT_EMAIL_PARAM: `/${projectSlug}/alert-email`,
        FROM_EMAIL_PARAM: `/${projectSlug}/contact-email-from`,
        SITE_LABEL: projectSlug,
      },
    });

    // Daily at 06:00 UTC, comfortably after CloudFront's log-delivery delay
    // (minutes to an hour), so the previous day's files have all landed
    new events.Rule(this, 'LogEtlSchedule', {
      ruleName: `${projectSlug}-log-etl-daily`,
      description: `Triggers ${projectSlug}-log-etl once per day`,
      schedule: events.Schedule.cron({ minute: '0', hour: '6' }),
      targets: [new targets.LambdaFunction(etlFunction)],
    });

    // ---------------------------------------------------------------------
    // Alarm on ETL failures: if the nightly job breaks, an email arrives the
    // next morning instead of the optimized table quietly going stale.
    // ---------------------------------------------------------------------
    const alertEmail = ssm.StringParameter.valueForStringParameter(this, `/${projectSlug}/alert-email`);

    const etlAlarmTopic = new sns.Topic(this, 'LogEtlAlarmTopic', {
      topicName: `${projectSlug}-log-etl-alarms`,
      displayName: `${projectSlug} log ETL failure alerts`,
    });
    etlAlarmTopic.addSubscription(new snsSubs.EmailSubscription(alertEmail));

    const etlErrorsAlarm = new cloudwatch.Alarm(this, 'LogEtlErrorsAlarm', {
      alarmName: `${projectSlug}-log-etl-errors`,
      alarmDescription: `Fires if ${projectSlug}-log-etl fails on its daily run`,
      metric: etlFunction.metricErrors({ period: cdk.Duration.hours(1) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    etlErrorsAlarm.addAlarmAction(new cwActions.SnsAction(etlAlarmTopic));

    new cdk.CfnOutput(this, 'LogEtlFunctionName', {
      value: etlFunction.functionName,
      description: 'Invoke manually with {"target_date": "YYYY-MM-DD"} to backfill a specific day',
    });

    new cdk.CfnOutput(this, 'AthenaDatabaseName', {
      value: database.ref,
      description: 'Glue/Athena database name for CloudFront logs',
    });

    new cdk.CfnOutput(this, 'AthenaWorkgroupName', {
      value: workgroup.name!,
      description: 'Select this workgroup in the Athena console before running queries',
    });

    new cdk.CfnOutput(this, 'AthenaResultsBucketName', {
      value: athenaResultsBucket.bucketName,
      description: 'S3 bucket holding Athena query result files',
    });
  }
}
