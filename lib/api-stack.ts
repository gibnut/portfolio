import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ses from 'aws-cdk-lib/aws-ses';
import { Construct } from 'constructs';
import { logRetention } from './common/utils/retention';

interface PortfolioAPIStackProps extends cdk.StackProps {
  domainName: string;
  // Physical-resource-name prefix (bin/app.ts)
  projectSlug: string;
  // The app-wide retention period (bin/app.ts), for the Lambda's log group
  retentionDays: number;
}

// Path of the contact form endpoint. Under /api/ so it can't collide with a
// page's clean URL (/contact is free for a page). CloudFront forwards the full
// path unchanged, so the '/api/contact' behavior in cdn-stack.ts and the form's
// endpoint in website/resume/index.html must match this exactly.
export const CONTACT_PATH = '/api/contact';

export class PortfolioAPIStack extends cdk.Stack {
  public readonly apiOriginDomain: string;
  public readonly apiEndpoint: string;

  constructor(scope: Construct, id: string, props: PortfolioAPIStackProps) {
    super(scope, id, props);

    const { domainName, projectSlug, retentionDays } = props;

    const fromEmail = ssm.StringParameter.valueForStringParameter(
      this, `/${projectSlug}/contact-email-from`,
    );
    const toEmail = ssm.StringParameter.valueForStringParameter(
      this, `/${projectSlug}/contact-email-to`,
    );

    // SES domain verification. The three DKIM CNAMEs below must exist in the
    // live DNS zone (added through zone.txt) before SES verifies the domain.
    const domainIdentity = new ses.EmailIdentity(this, 'DomainIdentity', {
      identity: ses.Identity.domain(domainName),
    });

    const dkimRecords: Array<[string, string]> = [
      [domainIdentity.dkimDnsTokenName1, domainIdentity.dkimDnsTokenValue1],
      [domainIdentity.dkimDnsTokenName2, domainIdentity.dkimDnsTokenValue2],
      [domainIdentity.dkimDnsTokenName3, domainIdentity.dkimDnsTokenValue3],
    ];
    dkimRecords.forEach(([name, value], i) => {
      new cdk.CfnOutput(this, `SESDKIMRecord${i + 1}`, {
        value: cdk.Fn.join('', [
          'CNAME: ', name, '._domainkey.', domainName,
          ' -> ', value, '.dkim.amazonses.com',
        ]),
        description: `SES DKIM record ${i + 1} - must exist in the live DNS zone (zone.txt)`,
      });
    });

    const logGroup = new logs.LogGroup(this, 'ContactFunctionLogs', {
      logGroupName: `/aws/lambda/${projectSlug}-contact-form`,
      retention: logRetention(retentionDays),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const contactFunction = new lambda.Function(this, 'ContactFunction', {
      functionName: `${projectSlug}-contact-form`,
      description: 'Handles contact form submissions and sends email via SES',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset('./lambda/contact'),
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      logGroup,
      environment: {
        SES_REGION: 'us-east-1',
        FROM_EMAIL: fromEmail,
        TO_EMAIL: toEmail,
        ALLOWED_ORIGIN: `https://${domainName}`,
      },
    });

    contactFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ses:SendEmail'],
      resources: ['*'],
    }));

    const api = new apigateway.HttpApi(this, 'ContactAPI', {
      apiName: `${projectSlug}-api`,
      description: `${projectSlug} contact form API`,
      corsPreflight: {
        allowOrigins: [`https://${domainName}`],
        allowMethods: [apigateway.CorsHttpMethod.POST, apigateway.CorsHttpMethod.OPTIONS],
        allowHeaders: ['Content-Type'],
        maxAge: cdk.Duration.hours(1),
      },
    });

    api.addRoutes({
      path: CONTACT_PATH,
      methods: [apigateway.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration(
        'ContactIntegration',
        contactFunction,
      ),
    });

    // Rate limit: 10 requests per second, bursts of 20
    const stage = api.defaultStage?.node.defaultChild as apigateway.CfnStage;
    if (stage) {
      stage.defaultRouteSettings = {
        throttlingRateLimit: 10,
        throttlingBurstLimit: 20,
      };
    }

    // Hostname from the API endpoint. Fn.select and Fn.split resolve at deploy
    // time, not synth time.
    this.apiOriginDomain = cdk.Fn.select(1, cdk.Fn.split('//', api.apiEndpoint));

    this.apiEndpoint = `${api.apiEndpoint}${CONTACT_PATH}`;

    new cdk.CfnOutput(this, 'APIEndpoint', {
      value: this.apiEndpoint,
      description: 'API Gateway endpoint - proxied via CloudFront, never exposed in HTML',
    });

    new cdk.CfnOutput(this, 'SESNote', {
      value: `The three DKIM CNAME records above must exist in the live DNS zone for ${domainName}`,
      description: 'SES domain verification depends on these DNS records',
    });
  }
}
