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

  constructor(scope: Construct, id: string, props: PortfolioStorageStackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, 'PortfolioBucket', {
      bucketName: props.domainName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      publicReadAccess: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      bucketKeyEnabled: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      serverAccessLogsPrefix: 'access-logs/',
    });

    this.bucket = bucket;
    this.bucketName = bucket.bucketName;
    this.bucketArn = bucket.bucketArn;

    // Add OAC bucket policy allowing CloudFront to read from S3
    // CloudFront distribution ARN is stored in SSM after first CDN deploy
    // and passed in on subsequent deploys
    if (props.cloudfrontDistributionArn) {
      bucket.addToResourcePolicy(new iam.PolicyStatement({
        sid: 'AllowCloudFrontOAC',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
        actions: ['s3:GetObject'],
        resources: [`${bucket.bucketArn}/*`],
        conditions: {
          StringEquals: {
            'AWS:SourceArn': props.cloudfrontDistributionArn,
          },
        },
      }));
    }

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
