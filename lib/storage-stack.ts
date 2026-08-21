import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

interface PortfolioStorageStackProps extends cdk.StackProps {
  domainName: string;
  // CloudFront distribution ARN passed in so we can add
  // the OAC bucket policy without a circular dependency
  // This is set after CDN stack is created — leave empty on first deploy
  cloudfrontDistributionArn?: string;
}

export class PortfolioStorageStack extends cdk.Stack {
  public readonly bucket: s3.Bucket;
  public readonly bucketName: string;
  public readonly bucketArn: string;
  public readonly loggingBucketName: string;

  constructor(scope: Construct, id: string, props: PortfolioStorageStackProps) {
    super(scope, id, props);

    const { domainName, cloudfrontDistributionArn } = props;

    // Dedicated logging bucket — separate from the website bucket
    // This eliminates the BucketDeployment conflict where CDK tried
    // to prune access log files from the website bucket on every deploy
    // S3 access logs and CloudFront logs both land here
    const loggingBucket = new s3.Bucket(this, 'LoggingBucket', {
      bucketName: `${domainName}-logs`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      publicReadAccess: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      bucketKeyEnabled: true,
      // Logs do not need versioning
      versioned: false,
      // Retain logs on stack deletion
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      // Lifecycle rule — expire logs after 90 days to control storage costs
      lifecycleRules: [
        {
          id: 'expire-logs',
          enabled: true,
          expiration: cdk.Duration.days(90),
        },
      ],
    });

    this.loggingBucketName = loggingBucket.bucketName;

    // Website bucket — no access logs prefix here since logs go to dedicated bucket
    const bucket = new s3.Bucket(this, 'PortfolioBucket', {
      bucketName: domainName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      publicReadAccess: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      bucketKeyEnabled: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      // S3 access logs now go to the dedicated logging bucket
      serverAccessLogsBucket: loggingBucket,
      serverAccessLogsPrefix: 's3-access-logs/',
    });

    this.bucket = bucket;
    this.bucketName = bucket.bucketName;
    this.bucketArn = bucket.bucketArn;

    // Add OAC bucket policy allowing CloudFront to read from S3
    // CloudFront distribution ARN stored in cdk.json context after first CDN deploy
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
      description: 'Dedicated logging bucket — receives S3 and CloudFront access logs',
    });
  }
}
