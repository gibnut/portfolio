import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

interface PortfolioCertificateStackProps extends cdk.StackProps {
  domainName: string;
  // Physical-resource-name prefix (bin/app.ts)
  projectSlug: string;
}

export class PortfolioCertificateStack extends cdk.Stack {
  // Exposed so the CDN stack can reference it
  public readonly certificate: acm.ICertificate;

  constructor(scope: Construct, id: string, props: PortfolioCertificateStackProps) {
    super(scope, id, props);

    const { domainName, projectSlug } = props;

    // Wildcard certificate covering example.com and *.example.com (www and
    // resume included).
    //
    // DNS validation: ACM issues a CNAME that must exist in whichever DNS zone
    // the registrar currently points to. That is deliberately done by hand
    // (fromDns() with no zone) rather than letting CDK write the record:
    // - During a migration the live zone may be in another account, where this
    //   app can't write; a record in a zone that isn't live yet never validates.
    // - Validating against the zone would make this stack depend on the DNS
    //   stack, which already depends on CDN -> certificate (a cycle).
    // Once issued, keep the CNAME in the live zone (zone.txt): renewal depends
    // on it. The record name and value are shown in the ACM console.
    const certificate = new acm.Certificate(this, 'Certificate', {
      domainName,
      subjectAlternativeNames: [`*.${domainName}`],
      validation: acm.CertificateValidation.fromDns(),
    });

    this.certificate = certificate;

    // Certificate ARN in SSM so local tooling can reference it without
    // hardcoding it
    new ssm.StringParameter(this, 'CertificateArnParameter', {
      parameterName: `/${projectSlug}/certificate-arn`,
      stringValue: certificate.certificateArn,
      description: `${projectSlug} ACM certificate ARN`,
    });

    new cdk.CfnOutput(this, 'CertificateArn', {
      value: certificate.certificateArn,
      description: 'ACM certificate ARN - do not commit to GitHub',
    });

    new cdk.CfnOutput(this, 'ValidationNote', {
      value: `Add the ACM DNS validation CNAME for ${domainName} and *.${domainName} to the live DNS zone, and keep it there (renewal depends on it)`,
      description: 'Manual step required to validate the certificate',
    });
  }
}
