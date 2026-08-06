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
  // Expose API endpoint so CDN stack can create proxy behavior
  public readonly apiEndpoint: string;

  constructor(scope: Construct, id: string, props: PortfolioAPIStackProps) {
    super(scope, id, props);

    const { domainName } = props;

    // Read sensitive email values from SSM Parameter Store
    // These are created via setup-ssm-params.ps1 before first deploy
    // Values never appear in code or GitHub
    const fromEmail = ssm.StringParameter.valueForStringParameter(
      this, '/portfolio/contact-email-from'
    );
    const toEmail = ssm.StringParameter.valueForStringParameter(
      this, '/portfolio/contact-email-to'
    );

    // SES domain verification
    // CDK creates the domain identity and outputs the DNS TXT record
    // You add the TXT record manually in GoDaddy
    const domainIdentity = new ses.EmailIdentity(this, 'DomainIdentity', {
      identity: ses.Identity.domain(domainName),
    });

    // Output DNS records needed for SES domain verification in GoDaddy
    new cdk.CfnOutput(this, 'SESDKIMRecord1', {
      value: `CNAME: ${domainIdentity.dkimDnsTokenName1}._domainkey.${domainName} -> ${domainIdentity.dkimDnsTokenValue1}.dkim.amazonses.com`,
      description: 'SES DKIM record 1 — add to GoDaddy',
    });

    new cdk.CfnOutput(this, 'SESDKIMRecord2', {
      value: `CNAME: ${domainIdentity.dkimDnsTokenName2}._domainkey.${domainName} -> ${domainIdentity.dkimDnsTokenValue2}.dkim.amazonses.com`,
      description: 'SES DKIM record 2 — add to GoDaddy',
    });

    new cdk.CfnOutput(this, 'SESDKIMRecord3', {
      value: `CNAME: ${domainIdentity.dkimDnsTokenName3}._domainkey.${domainName} -> ${domainIdentity.dkimDnsTokenValue3}.dkim.amazonses.com`,
      description: 'SES DKIM record 3 — add to GoDaddy',
    });

    // CloudWatch log group for Lambda
    const logGroup = new logs.LogGroup(this, 'ContactFunctionLogs', {
      logGroupName: '/aws/lambda/portfolio-contact-form',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Lambda function — Python contact form handler
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
        // CloudFront proxies /contact to API Gateway
        // so ALLOWED_ORIGIN is your domain, not the API Gateway URL
        ALLOWED_ORIGIN: `https://${domainName}`,
      },
    });

    // Grant Lambda permission to send email via SES only
    // Least privilege — no other permissions
    contactFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ses:SendEmail'],
      resources: ['*'],
    }));

    // HTTP API Gateway
    const api = new apigateway.HttpApi(this, 'ContactAPI', {
      apiName: 'portfolio-api',
      description: 'portfolio contact form API',
      corsPreflight: {
        // Allow requests from your domain via CloudFront proxy
        allowOrigins: [`https://${domainName}`],
        allowMethods: [apigateway.CorsHttpMethod.POST, apigateway.CorsHttpMethod.OPTIONS],
        allowHeaders: ['Content-Type'],
        maxAge: cdk.Duration.hours(1),
      },
    });

    // POST /contact route triggers Lambda
    api.addRoutes({
      path: '/contact',
      methods: [apigateway.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration(
        'ContactIntegration',
        contactFunction
      ),
    });

    // Throttling to prevent abuse and runaway costs
    const stage = api.defaultStage?.node.defaultChild as apigateway.CfnStage;
    if (stage) {
      stage.defaultRouteSettings = {
        throttlingRateLimit: 10,
        throttlingBurstLimit: 20,
      };
    }

    // Expose endpoint for CDN stack proxy behavior
    this.apiEndpoint = `${api.apiEndpoint}/contact`;

    // Output is for your reference only — never appears in HTML source
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
