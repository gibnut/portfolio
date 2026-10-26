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
import * as path from 'path';

export interface PortfolioAthenaStackProps extends cdk.StackProps {
  /** Real domain name, read from cdk.json context (gitignored) — used only to name the results bucket */
  domainName: string;
  /** Logging bucket name, passed from PortfolioStorageStack — same value PortfolioCDNStack already receives */
  loggingBucketName: string;
  /**
   * ARN of the AWS-managed "AWS SDK for pandas" Lambda layer (includes pyarrow),
   * for this account's region and Python 3.12. Look this up yourself rather than
   * trust a hardcoded version here — AWS periodically publishes new layer versions
   * and an old one can be deprecated:
   *   Lambda console → Layers → "Add a layer" → AWS layers →
   *   search "AWSSDKPandas-Python312" → copy the ARN shown for your region.
   * Set as `pandasLayerArn` in cdk.json context, same pattern as domainName.
   */
  pandasLayerArn: string;
}

/**
 * PortfolioAthenaStack
 *
 * Stands up Athena/Glue resources to query the CloudFront access logs that
 * PortfolioStorageStack already writes to `${domainName}-logs/cloudfront-logs/`.
 *
 * This stack does NOT touch the logging bucket's lifecycle rules or the
 * BucketDeployment in PortfolioCDNStack — it only reads from the existing
 * bucket via an imported reference, so there's no risk of it pruning logs.
 */
export class PortfolioAthenaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PortfolioAthenaStackProps) {
    super(scope, id, props);

    const { domainName, loggingBucketName } = props;

    // Imported, not created — the logging bucket already exists from PortfolioStorageStack.
    // fromBucketName avoids taking ownership / any risk of this stack managing its lifecycle.
    s3.Bucket.fromBucketName(this, 'ImportedLoggingBucket', loggingBucketName);

    // Dedicated bucket for Athena's own query result files, kept separate from
    // the CloudFront logs so nothing here interacts with the 90-day log lifecycle rule.
    const athenaResultsBucket = new s3.Bucket(this, 'AthenaResultsBucket', {
      bucketName: `${domainName}-athena-results`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [
        {
          id: 'expire-query-results',
          expiration: cdk.Duration.days(30),
        },
      ],
      // Query-result files are cheap to regenerate — safe to fully clean up if the stack is ever torn down
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Glue database Athena queries against
    const database = new glue.CfnDatabase(this, 'PortfolioLogsDatabase', {
      catalogId: this.account,
      databaseInput: {
        name: 'portfolio_logs',
        description: 'Database for portfolio CloudFront access logs',
      },
    });

    // Table schema matches the current CloudFront standard log format:
    // tab-delimited, 33 columns, 2 header lines (#Version, #Fields) to skip,
    // gzip files read transparently by TextInputFormat.
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
    cloudfrontLogsTable.addDependency(database);

    // Workgroup pins query results to the dedicated bucket and caps scanned bytes per query
    const workgroup = new athena.CfnWorkGroup(this, 'PortfolioAthenaWorkgroup', {
      name: 'portfolio-logs',
      description: 'Workgroup for querying portfolio CloudFront logs',
      state: 'ENABLED',
      workGroupConfiguration: {
        resultConfiguration: {
          outputLocation: `s3://${athenaResultsBucket.bucketName}/query-results/`,
        },
        enforceWorkGroupConfiguration: true,
        publishCloudWatchMetricsEnabled: true,
        bytesScannedCutoffPerQuery: 1_000_000_000, // 1 GB safety cap per query — logs are small, this is generous headroom
      },
    });

    // Saved queries, ready to run as-is from the Athena console (Saved queries tab)
    const topPagesQuery = new athena.CfnNamedQuery(this, 'TopPagesQuery', {
      database: database.ref,
      workGroup: workgroup.name,
      name: 'top-pages-last-7-days',
      description: 'Most-requested URI paths in the last 7 days',
      queryString: `
SELECT cs_uri_stem, COUNT(*) AS requests
FROM cloudfront_logs
WHERE "date" >= date_add('day', -7, current_date)
GROUP BY cs_uri_stem
ORDER BY requests DESC
LIMIT 25;
      `.trim(),
    });
    topPagesQuery.addDependency(workgroup);


    const humanVsBotQuery = new athena.CfnNamedQuery(this, 'HumanVsBotQuery', {
      database: database.ref,
      workGroup: workgroup.name,
      name: 'likely-human-vs-bot-traffic',
      description: 'Rough split of requests by common bot/crawler user agents vs everything else',
      queryString: `
SELECT
  CASE
    WHEN lower(cs_user_agent) LIKE '%bot%'
      OR lower(cs_user_agent) LIKE '%spider%'
      OR lower(cs_user_agent) LIKE '%crawl%'
      OR lower(cs_user_agent) LIKE '%curl%'
      OR lower(cs_user_agent) LIKE '%wget%'
      OR lower(cs_user_agent) LIKE '%python-requests%'
      OR lower(cs_user_agent) LIKE '%headlesschrome%'
      OR lower(cs_user_agent) LIKE '%facebookexternalhit%'
      OR lower(cs_user_agent) LIKE '%semrush%'
      OR lower(cs_user_agent) LIKE '%ahrefsbot%'
    THEN 'likely_bot'
    ELSE 'likely_human'
  END AS traffic_type,
  COUNT(*) AS requests,
  COUNT(DISTINCT c_ip) AS distinct_ips
FROM cloudfront_logs
GROUP BY 1
ORDER BY requests DESC;
      `.trim(),
    });
    humanVsBotQuery.addDependency(workgroup);


    const trafficByDayQuery = new athena.CfnNamedQuery(this, 'TrafficByDayQuery', {
      database: database.ref,
      workGroup: workgroup.name,
      name: 'traffic-by-day',
      description: 'Daily request volume and unique visitor count',
      queryString: `
SELECT
  "date",
  COUNT(*) AS requests,
  COUNT(DISTINCT c_ip) AS unique_ips
FROM cloudfront_logs
GROUP BY "date"
ORDER BY "date" DESC;
      `.trim(),
    });
    trafficByDayQuery.addDependency(workgroup);


    const statusCodeBreakdownQuery = new athena.CfnNamedQuery(this, 'StatusCodeBreakdownQuery', {
      database: database.ref,
      workGroup: workgroup.name,
      name: 'status-code-breakdown',
      description: 'Request counts grouped by HTTP status code',
      queryString: `
SELECT sc_status, COUNT(*) AS requests
FROM cloudfront_logs
GROUP BY sc_status
ORDER BY requests DESC;
      `.trim(),
    });
    statusCodeBreakdownQuery.addDependency(workgroup);


    const referrerBreakdownQuery = new athena.CfnNamedQuery(this, 'ReferrerBreakdownQuery', {
      database: database.ref,
      workGroup: workgroup.name,
      name: 'top-referrers',
      description: 'Where traffic is coming from, excluding direct/empty referrers',
      queryString: `
SELECT cs_referer, COUNT(*) AS requests
FROM cloudfront_logs
WHERE cs_referer != '-'
GROUP BY cs_referer
ORDER BY requests DESC
LIMIT 25;
      `.trim(),
    });
    referrerBreakdownQuery.addDependency(workgroup);


    // ---------------------------------------------------------------------
    // Optimized, partitioned table — Parquet under cloudfront-logs-optimized/
    // in the SAME logging bucket (no new bucket). The ETL Lambda below is
    // what actually populates this and registers each day's partition;
    // there's no Glue Crawler, since the Lambda already knows the exact
    // partition values it just wrote.
    // ---------------------------------------------------------------------
    const optimizedTable = new glue.CfnTable(this, 'CloudFrontLogsOptimizedTable', {
      catalogId: this.account,
      databaseName: database.ref,
      tableInput: {
        name: 'cloudfront_logs_optimized',
        description: 'Parquet, partitioned CloudFront logs — populated daily by portfolio-log-etl',
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
          // Same 33 columns as cloudfront_logs, minus the partition keys (Glue
          // tracks those separately via partitionKeys above, not in this list).
          // date is 'string' here (not 'date' like the raw table) and c_port
          // is 'bigint' (not 'int') because that's what the ETL Lambda's
          // pandas dtype map actually produces in the Parquet file — Parquet's
          // strict physical-type checking rejects any mismatch, unlike the
          // raw table's more lenient TSV SerDe.
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
    optimizedTable.addDependency(database);

    // ---------------------------------------------------------------------
    // ETL Lambda — converts yesterday's raw logs to Parquet, registers the
    // partition, queries its own output for a daily summary, and emails it
    // via the existing verified SES domain. One function covers both the
    // partitioning pipeline and the automated report.
    // ---------------------------------------------------------------------
    const pandasLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      'PandasLayer',
      props.pandasLayerArn,
    );

    const etlRole = new iam.Role(this, 'LogEtlRole', {
      roleName: 'portfolio-log-etl-role',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Read raw logs, write optimized logs — same bucket, two prefixes, least-privilege scoped to each
    const loggingBucketForGrants = s3.Bucket.fromBucketName(this, 'ImportedLoggingBucketForEtl', loggingBucketName);
    loggingBucketForGrants.grantRead(etlRole, 'cloudfront-logs/*');
    loggingBucketForGrants.grantReadWrite(etlRole, 'cloudfront-logs-optimized/*');

    // grantWrite alone is NOT enough for Athena's StartQueryExecution — it only
    // covers object-level actions. Athena separately requires bucket-level
    // s3:GetBucketLocation and s3:ListBucket on the output bucket itself before
    // it will even attempt to use it, or StartQueryExecution fails with
    // "Unable to verify/create output bucket" (confirmed against AWS's own
    // documented required policy for this exact error).
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

    // SES send permission — resource '*' since SES v1 SendEmail doesn't support
    // scoping to a specific identity ARN the way some other actions do
    etlRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: ['*'],
    }));

    etlRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/portfolio/alert-email`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/portfolio/contact-email-from`,
      ],
    }));

    const etlFunction = new lambda.Function(this, 'LogEtlFunction', {
      functionName: 'portfolio-log-etl',
      description: 'Converts previous day\'s CloudFront logs to partitioned Parquet and emails a traffic summary',
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.X86_64, // must match the pandas layer's architecture
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'log-etl')),
      layers: [pandasLayer],
      role: etlRole,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      environment: {
        LOG_BUCKET: loggingBucketName,
        RAW_PREFIX: 'cloudfront-logs/',
        OPTIMIZED_PREFIX: 'cloudfront-logs-optimized/',
        GLUE_DATABASE: database.ref,
        OPTIMIZED_TABLE: 'cloudfront_logs_optimized',
        ATHENA_WORKGROUP: workgroup.name!,
        RESULTS_BUCKET: athenaResultsBucket.bucketName,
        ALERT_EMAIL_PARAM: '/portfolio/alert-email',
        FROM_EMAIL_PARAM: '/portfolio/contact-email-from',
      },
    });

    // Daily at 06:00 UTC — comfortably after CloudFront's log-delivery delay
    // (minutes to an hour, per your own notes), so the previous day's files
    // have all landed by the time this runs
    new events.Rule(this, 'LogEtlSchedule', {
      ruleName: 'portfolio-log-etl-daily',
      description: 'Triggers portfolio-log-etl once per day',
      schedule: events.Schedule.cron({ minute: '0', hour: '6' }),
      targets: [new targets.LambdaFunction(etlFunction)],
    });

    // ---------------------------------------------------------------------
    // Alarm on ETL failures — built for growth: if this silently breaks,
    // you find out the next morning instead of months later when someone
    // notices the optimized table stopped updating.
    // ---------------------------------------------------------------------
    const alertEmail = ssm.StringParameter.valueForStringParameter(this, '/portfolio/alert-email');

    const etlAlarmTopic = new sns.Topic(this, 'LogEtlAlarmTopic', {
      topicName: 'portfolio-log-etl-alarms',
      displayName: 'Portfolio log ETL failure alerts',
    });
    etlAlarmTopic.addSubscription(new snsSubs.EmailSubscription(alertEmail));

    const etlErrorsAlarm = new cloudwatch.Alarm(this, 'LogEtlErrorsAlarm', {
      alarmName: 'portfolio-log-etl-errors',
      alarmDescription: 'Fires if portfolio-log-etl fails on its daily run',
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
