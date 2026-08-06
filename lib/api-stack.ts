import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ses from 'aws-cdk-lib/aws-ses';
import { Construct } from 'constructs';

interface PortfolioAPIStackProps extends cdk.StackProps {
  domainName: string;
}

export class PortfolioAPIStack extends cdk.Stack {
  public readonly apiOriginDomain: string;
  public readonly apiEndpoint: string;

  constructor(scope: Construct, id: string, props: PortfolioAPIStackProps) {
    super(scope, id, props);

    const { domainName } = props;

    const fromEmail = ssm.StringParameter.valueForStringParameter(
      this, '/portfolio/contact-email-from'
    );
    const toEmail = ssm.StringParameter.valueForStringParameter(
      this, '/portfolio/contact-email-to'
    );

    // SES domain verification
    const domainIdentity = new ses.EmailIdentity(this, 'DomainIdentity', {
      identity: ses.Identity.domain(domainName),
    });

    new cdk.CfnOutput(this, 'SESDKIMRecord1', {
      value: cdk.Fn.join('', [
        'CNAME: ', domainIdentity.dkimDnsTokenName1,
        '._domainkey.', domainName,
        ' -> ', domainIdentity.dkimDnsTokenValue1,
        '.dkim.amazonses.com'
      ]),
      description: 'SES DKIM record 1 — add to GoDaddy',
    });

    new cdk.CfnOutput(this, 'SESDKIMRecord2', {
      value: cdk.Fn.join('', [
        'CNAME: ', domainIdentity.dkimDnsTokenName2,
        '._domainkey.', domainName,
        ' -> ', domainIdentity.dkimDnsTokenValue2,
        '.dkim.amazonses.com'
      ]),
      description: 'SES DKIM record 2 — add to GoDaddy',
    });

    new cdk.CfnOutput(this, 'SESDKIMRecord3', {
      value: cdk.Fn.join('', [
        'CNAME: ', domainIdentity.dkimDnsTokenName3,
        '._domainkey.', domainName,
        ' -> ', domainIdentity.dkimDnsTokenValue3,
        '.dkim.amazonses.com'
      ]),
      description: 'SES DKIM record 3 — add to GoDaddy',
    });

    const logGroup = new logs.LogGroup(this, 'ContactFunctionLogs', {
      logGroupName: '/aws/lambda/portfolio-contact-form',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const contactFunction = new lambda.Function(this, 'ContactFunction', {
      functionName: 'portfolio-contact-form',
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
      apiName: 'portfolio-api',
      description: 'portfolio contact form API',
      corsPreflight: {
        allowOrigins: [`https://${domainName}`],
        allowMethods: [apigateway.CorsHttpMethod.POST, apigateway.CorsHttpMethod.OPTIONS],
        allowHeaders: ['Content-Type'],
        maxAge: cdk.Duration.hours(1),
      },
    });

    api.addRoutes({
      path: '/contact',
      methods: [apigateway.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration(
        'ContactIntegration',
        contactFunction
      ),
    });

    const stage = api.defaultStage?.node.defaultChild as apigateway.CfnStage;
    if (stage) {
      stage.defaultRouteSettings = {
        throttlingRateLimit: 10,
        throttlingBurstLimit: 20,
      };
    }

    // Extract hostname from API endpoint token safely
    // cdk.Fn.select and cdk.Fn.split resolve at deploy time, not synth time
    this.apiOriginDomain = cdk.Fn.select(1,
      cdk.Fn.split('//', api.apiEndpoint)
    );

    this.apiEndpoint = `${api.apiEndpoint}/contact`;

    new cdk.CfnOutput(this, 'APIEndpoint', {
      value: this.apiEndpoint,
      description: 'API Gateway endpoint — proxied via CloudFront, never exposed in HTML',
    });

    new cdk.CfnOutput(this, 'SESNote', {
      value: `Add the three DKIM CNAME records above to GoDaddy for ${domainName}`,
      description: 'Manual DNS step required for SES domain verification',
    });
  }
}
