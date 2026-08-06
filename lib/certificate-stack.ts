import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

interface PortfolioCertificateStackProps extends cdk.StackProps {
  domainName: string;
}

export class PortfolioCertificateStack extends cdk.Stack {
  // Expose certificate so CDN stack can reference it
  public readonly certificate: acm.ICertificate;

  constructor(scope: Construct, id: string, props: PortfolioCertificateStackProps) {
    super(scope, id, props);

    const { domainName } = props;

    // Wildcard certificate covers example.com and *.example.com
    // DNS validation requires adding a CNAME record in GoDaddy
    // CDK will output the required CNAME values after deploy
    const certificate = new acm.Certificate(this, 'Certificate', {
      domainName: domainName,
      subjectAlternativeNames: [`*.${domainName}`],
      validation: acm.CertificateValidation.fromDns(),
    });

    this.certificate = certificate;

    // Store certificate ARN in SSM so other stacks and local tooling
    // can reference it without hardcoding sensitive values
    new ssm.StringParameter(this, 'CertificateArnParameter', {
      parameterName: '/portfolio/certificate-arn',
      stringValue: certificate.certificateArn,
      description: 'portfolio ACM certificate ARN',
    });

    // Output the certificate ARN and validation details
    new cdk.CfnOutput(this, 'CertificateArn', {
      value: certificate.certificateArn,
      description: 'ACM Certificate ARN — store this safely, do not commit to GitHub',
    });

    new cdk.CfnOutput(this, 'ValidationNote', {
      value: `Add the DNS CNAME validation record to GoDaddy for ${domainName} and *.${domainName}`,
      description: 'Manual step required to validate the certificate',
    });
  }
}
