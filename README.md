# portfolio

AWS CDK infrastructure for a personal digital CV and portfolio site.

## Architecture

```
Route 53 DNS
    └── CloudFront Distribution (portfolio)
            ├── Redirect Function (www → apex, resume subdomain → /resume)
            ├── Security Headers
            └── S3 Origin (private bucket via OAC)
                    └── website/
                            ├── index.html         (homepage)
                            └── resume/
                                    └── index.html (digital CV)

Contact Form
    └── API Gateway (portfolio-api)
            └── Lambda (portfolio-contact-form)
                    └── SES → your email

Logging
    └── S3 Logging Bucket (domain-logs)
            ├── s3-access-logs/     (S3 access logs)
            └── cloudfront-logs/    (CloudFront access logs)
```

## Stacks

| Stack | Resources |
|---|---|
| `PortfolioCertificateStack` | ACM wildcard certificate |
| `PortfolioStorageStack` | S3 website bucket, dedicated logging bucket |
| `PortfolioCDNStack` | CloudFront distribution, OAC, redirect function, security headers, website deployment |
| `PortfolioAPIStack` | Lambda contact form, API Gateway, SES domain verification |
| `PortfolioDNSStack` | Route 53 hosted zone, alias records, zone file import |
| `PortfolioBudgetStack` | Monthly cost budget and alert |

## Prerequisites

- Node.js 20+
- AWS CDK v2: `npm install -g aws-cdk`
- AWS CLI configured with a named profile
- AWS IAM Identity Center configured for authentication
- CDK bootstrapped: `cdk bootstrap aws://ACCOUNT_ID/us-east-1 --profile YOUR_PROFILE`

## Setup

### 1. Clone and install dependencies

```powershell
git clone https://github.com/yourusername/portfolio.git
cd portfolio
npm install
```

### 2. Configure CDK context

```powershell
cp cdk.json.example cdk.json
```

Edit `cdk.json` and set your domain name and CloudFront distribution ARN. The distribution ARN
is added after the first CDN stack deployment and used to apply the OAC bucket policy:

```json
{
  "context": {
    "domainName": "your-domain.com",
    "cloudfrontDistributionArn": "arn:aws:cloudfront::ACCOUNT_ID:distribution/DISTRIBUTION_ID"
  }
}
```

`cdk.json` is gitignored and will not be committed.

### 3. Create SSM parameters

Sensitive values are stored in AWS SSM Parameter Store — never in code or GitHub.

Run the setup script before first deployment:

```powershell
.\scripts\setup-ssm-params.ps1 -FromEmail "noreply@yourdomain.com" -ToEmail "you@yourdomain.com" -Profile "your-profile"
```

This creates:
- `/portfolio/contact-email-from`
- `/portfolio/contact-email-to`

Also create the following parameters manually after deploying the relevant stacks:

```powershell
# After deploying PortfolioCDNStack
aws ssm put-parameter --name "/portfolio/cloudfront-domain" --value "d1234abcd.cloudfront.net" --type "String" --profile your-profile

# For the budget alert email
aws ssm put-parameter --name "/portfolio/alert-email" --value "you@yourdomain.com" --type "String" --profile your-profile
```

### 4. Prepare the DNS zone file

The DNS stack reads `zone.txt` from the project root at synth time. This file is gitignored
and never committed. Export your zone file from your registrar and place it at the project root:

```
portfolio/
  zone.txt    ← gitignored, place your exported zone file here
```

SOA and NS records are skipped automatically — Route 53 manages these. A, CNAME records for
the apex domain, www, and resume subdomains are also skipped since they are handled as
CloudFront alias records in the DNS stack.

### 5. Deploy

Authenticate with AWS before running any CDK commands:

```powershell
aws sso login --profile your-profile
$env:AWS_PROFILE = "your-profile"
```

Deploy in order — the certificate must be validated before the CDN stack can deploy:

```powershell
# Deploy certificate first
cdk deploy PortfolioCertificateStack

# Add the DNS validation CNAME record shown in the stack output to your registrar
# Wait for the certificate status to reach Issued in ACM

# Deploy storage and API stacks
cdk deploy PortfolioStorageStack
cdk deploy PortfolioAPIStack

# Deploy CDN stack — requires certificate to be Issued
cdk deploy PortfolioCDNStack

# After CDN deploys:
# 1. Copy the CloudFront distribution ARN from stack output into cdk.json
# 2. Copy the CloudFront domain into SSM (/portfolio/cloudfront-domain)
# 3. Redeploy storage stack to apply the OAC bucket policy
cdk deploy PortfolioStorageStack

# Deploy DNS stack — creates Route 53 hosted zone and imports zone.txt records
cdk deploy PortfolioDNSStack

# After DNS deploys:
# Update your registrar nameservers to the four Route 53 nameservers shown in stack output

# Deploy budget stack
cdk deploy PortfolioBudgetStack
```

### 6. Update the contact form endpoint

The contact form endpoint is proxied through CloudFront so the API Gateway URL is never
exposed in the HTML source. Update the `ENDPOINT` constant in `website/resume/index.html`:

```javascript
const ENDPOINT = 'https://yourdomain.com/contact';
```

### 7. Invalidate the CloudFront cache after content updates

After updating any HTML files and redeploying the CDN stack, invalidate the cache:

```powershell
aws cloudfront create-invalidation --distribution-id YOUR_DISTRIBUTION_ID --paths "/*" --profile your-profile
```

## Project Structure

```
portfolio/
  bin/
    app.ts                    CDK app entry point
  lib/
    certificate-stack.ts      ACM wildcard certificate
    storage-stack.ts          S3 website bucket and dedicated logging bucket
    cdn-stack.ts              CloudFront distribution, OAC, redirect function, website deployment
    api-stack.ts              Lambda contact form, API Gateway, SES domain verification
    dns-stack.ts              Route 53 hosted zone, alias records, zone file parser
    budget-stack.ts           Monthly cost budget and alert
  lambda/
    contact/
      handler.py              Contact form Lambda function
  website/
    resume/
      index.html              Digital CV page
  scripts/
    setup-ssm-params.ps1      Creates SSM parameters before first deploy
  zone.txt                    Gitignored — exported zone file from registrar
  cdk.json.example            Safe to commit — copy to cdk.json and fill in values
  cdk.json                    Gitignored — contains domain name and CloudFront ARN
  .gitignore
  README.md
  package.json
  tsconfig.json
```

## Security

- S3 website bucket has all public access blocked
- CloudFront accesses S3 via Origin Access Control — no direct S3 access possible
- Security headers enforced on all CloudFront responses
- Contact form rate limited at API Gateway — 10 requests per second
- API Gateway endpoint proxied through CloudFront — never exposed in HTML source
- Sensitive values stored in SSM Parameter Store — never in code or GitHub
- HTTPS enforced via CloudFront viewer protocol policy
- ACM wildcard certificate covers apex domain and all subdomains
- S3 and CloudFront access logs written to a dedicated logging bucket
- Logs expire automatically after 90 days

## Cost estimate

| Service | Estimated monthly cost |
|---|---|
| Route 53 hosted zone | ~$0.50 |
| S3 | ~$0.00 |
| CloudFront | ~$0.00 |
| Lambda | ~$0.00 |
| API Gateway | ~$0.00 |
| SES | ~$0.00 |
| **Total** | **~$0.50/month** |

A monthly AWS Budget alert is deployed at $5 to catch anything unexpected.
