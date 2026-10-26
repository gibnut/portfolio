import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

interface PortfolioStorageStackProps extends cdk.StackProps {
  domainName: string;
  // Physical-resource-name prefix (bin/app.ts)
  projectSlug: string;
  // CloudFront distribution ARN, passed in so the OAC bucket policy can be
  // added here without a circular dependency on the CDN stack. Not set until
  // after the first CDN deploy.
  cloudfrontDistributionArn?: string;
  // The app-wide retention period (bin/app.ts): how long logs and old website
  // file versions are kept
  retentionDays: number;
}

export class PortfolioStorageStack extends cdk.Stack {
  public readonly bucket: s3.Bucket;
  public readonly bucketName: string;
  public readonly bucketArn: string;
  public readonly loggingBucketName: string;

  constructor(scope: Construct, id: string, props: PortfolioStorageStackProps) {
    super(scope, id, props);

    const { domainName, projectSlug, cloudfrontDistributionArn, retentionDays } = props;

    // Dedicated logging bucket, separate from the website bucket, so
    // BucketDeployment can never prune log files. S3 access logs and CloudFront
    // logs both land here.
    const loggingBucket = new s3.Bucket(this, 'LoggingBucket', {
      bucketName: `${domainName}-logs`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      publicReadAccess: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      bucketKeyEnabled: true,
      // CloudFront standard (legacy) logging writes log files with an ACL, so
      // this bucket must have ACLs enabled. New buckets default to
      // BucketOwnerEnforced (ACLs disabled); set the ownership explicitly
      // rather than relying on a CDK default.
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      // Logs do not need versioning
      versioned: false,
      // Keep logs if the stack is ever deleted
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      // Expire logs after retentionDays (bin/app.ts). Covers everything in the
      // bucket: CloudFront logs, S3 access logs, and the Athena stack's Parquet
      // copies (so traffic history goes back this far).
      lifecycleRules: [
        {
          id: 'expire-logs',
          enabled: true,
          expiration: cdk.Duration.days(retentionDays),
        },
      ],
    });

    this.loggingBucketName = loggingBucket.bucketName;

    // Website bucket. Private; CloudFront reads it through OAC.
    const bucket = new s3.Bucket(this, 'PortfolioBucket', {
      bucketName: domainName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      publicReadAccess: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      bucketKeyEnabled: true,
      versioned: true,
      // Versioning keeps every replaced or deleted file. Old versions are
      // removed retentionDays after they're replaced, and the empty delete
      // markers deploys leave behind are cleaned up; without this rule old
      // versions are kept forever. Current files are never touched. (The site's
      // history is also in git.)
      lifecycleRules: [
        {
          id: 'expire-old-versions',
          enabled: true,
          noncurrentVersionExpiration: cdk.Duration.days(retentionDays),
          expiredObjectDeleteMarker: true,
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      serverAccessLogsBucket: loggingBucket,
      serverAccessLogsPrefix: 's3-access-logs/',
    });

    this.bucket = bucket;
    this.bucketName = bucket.bucketName;
    this.bucketArn = bucket.bucketArn;

    // OAC bucket policy allowing CloudFront to read from S3, scoped to the
    // distribution ARN stored in cdk.json after the first CDN deploy
    if (cloudfrontDistributionArn) {
      bucket.addToResourcePolicy(new iam.PolicyStatement({
        sid: 'AllowCloudFrontOAC',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
        actions: ['s3:GetObject'],
        resources: [`${bucket.bucketArn}/*`],
        conditions: {
          StringEquals: {
            'AWS:SourceArn': cloudfrontDistributionArn,
          },
        },
      }));
    } else {
      // Without this policy CloudFront can't read the bucket, so every page
      // returns the 404 page. Expected only on a first deploy, before the CDN
      // stack exists (README, "Deploy").
      cdk.Annotations.of(this).addWarningV2(
        `${projectSlug}:storage:oacPolicyNotAttached`,
        'cloudfrontDistributionArn is not set in cdk.json, so the OAC bucket policy is not attached and CloudFront cannot read the website bucket. Set it after the first CDN deploy, then redeploy this stack.',
      );
    }

    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.bucketName,
      description: 'S3 website bucket name',
    });

    new cdk.CfnOutput(this, 'BucketArn', {
      value: bucket.bucketArn,
      description: 'S3 website bucket ARN',
    });

    new cdk.CfnOutput(this, 'LoggingBucketName', {
      value: loggingBucket.bucketName,
      description: 'Dedicated logging bucket - receives S3 and CloudFront access logs',
    });
  }
}
