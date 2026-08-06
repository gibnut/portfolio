import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';

interface PortfolioStorageStackProps extends cdk.StackProps {
  domainName: string;
}

export class PortfolioStorageStack extends cdk.Stack {
  // Expose bucket so CDN stack can grant CloudFront access
  public readonly bucket: s3.IBucket;

  constructor(scope: Construct, id: string, props: PortfolioStorageStackProps) {
    super(scope, id, props);

    const { domainName } = props;

    // Private S3 bucket — no public access at any level
    // CloudFront accesses via OAC defined in CDN stack
    const bucket = new s3.Bucket(this, 'PortfolioBucket', {
      bucketName: domainName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      publicReadAccess: false,

      // Encrypt at rest with S3 managed keys
      encryption: s3.BucketEncryption.S3_MANAGED,
      bucketKeyEnabled: true,

      // Versioning protects against accidental overwrites
      versioned: true,

      // Retain bucket on stack deletion to prevent accidental data loss
      // Change to DESTROY if you want cdk destroy to remove the bucket
      removalPolicy: cdk.RemovalPolicy.RETAIN,

      // Server access logging
      serverAccessLogsPrefix: 'access-logs/',
    });

    this.bucket = bucket;

    // Deploy website assets from local website/ folder to S3
    // This runs on every cdk deploy and syncs changed files
    new s3deploy.BucketDeployment(this, 'DeployWebsite', {
      sources: [s3deploy.Source.asset('./website')],
      destinationBucket: bucket,
      // Cache HTML for 5 minutes, assets longer
      cacheControl: [
        s3deploy.CacheControl.fromString('max-age=300, must-revalidate'),
      ],
    });

    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.bucketName,
      description: 'S3 bucket name',
    });

    new cdk.CfnOutput(this, 'BucketArn', {
      value: bucket.bucketArn,
      description: 'S3 bucket ARN',
    });
  }
}
