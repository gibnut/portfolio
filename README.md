# portfolio

AWS CDK infrastructure for a personal digital CV and portfolio site.

## Architecture

```
Route 53 DNS
    └── CloudFront Distribution (portfolio)
            ├── Redirect Function (www → apex, resume subdomain → /resume,
            │                      edge allowlist rejects non-site requests)
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
            ├── s3-access-logs/            (S3 access logs)
            ├── cloudfront-logs/           (raw CloudFront access logs)
            └── cloudfront-logs-optimized/ (partitioned Parquet, written by the ETL Lambda below)

Log Analysis
    └── Athena / Glue (portfolio_logs database)
            ├── cloudfront_logs           (raw, queries the logs above directly)
            ├── cloudfront_logs_optimized (partitioned Parquet — faster, cheaper to query)
            └── Lambda (portfolio-log-etl), daily via EventBridge
                    ├── raw logs → Parquet → cloudfront-logs-optimized/
                    ├── registers the day's partition
                    └── SES → daily traffic summary email
```

## Stacks

| Stack | Resources |
|---|---|
| `PortfolioCertificateStack` | ACM wildcard certificate |
| `PortfolioStorageStack` | S3 website bucket, dedicated logging bucket |
| `PortfolioCDNStack` | CloudFront distribution, OAC, redirect function (with edge allowlist), security headers, website deployment |
| `PortfolioAPIStack` | Lambda contact form, API Gateway, SES domain verification |
| `PortfolioDNSStack` | Route 53 hosted zone, alias records, zone file import |
| `PortfolioBudgetStack` | Monthly cost budget and alert |
| `PortfolioAthenaStack` | Glue database/tables, Athena workgroup + saved queries, ETL Lambda, EventBridge schedule, CloudWatch alarm |

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

Edit `cdk.json` and set your domain name, CloudFront distribution ARN, and the pandas Lambda
layer ARN used by the log-analysis ETL job:

```json
{
  "context": {
    "domainName": "your-domain.com",
    "cloudfrontDistributionArn": "arn:aws:cloudfront::ACCOUNT_ID:distribution/DISTRIBUTION_ID",
    "pandasLayerArn": "arn:aws:lambda:us-east-1:336392948345:layer:AWSSDKPandas-Python312:<version>"
  }
}
```

The distribution ARN is added after the first CDN stack deployment and used to apply the OAC
bucket policy. The pandas layer ARN is AWS-managed and versioned — look up the current one
yourself rather than trust a hardcoded number here, since AWS periodically retires old versions:
Lambda console → **Layers** → **Add a layer** → **AWS layers** → search
`AWSSDKPandas-Python312` → copy the ARN shown for your region.

`cdk.json` is gitignored and will not be committed. Update `cdk.json.example` too if you add
new context keys, so the example stays in sync with what the app actually requires.

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

# For the budget alert email — also used by PortfolioAthenaStack's ETL failure
# alarm and its daily traffic summary email
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

# Deploy Athena stack — only depends on PortfolioStorageStack, so this can run
# any time after step "Deploy storage and API stacks" above. Requires
# pandasLayerArn to already be set in cdk.json (step 2).
cdk deploy PortfolioAthenaStack
```

After `PortfolioAthenaStack` deploys, you can test the ETL pipeline immediately instead of
waiting for the daily schedule:

```powershell
aws lambda invoke --function-name portfolio-log-etl --profile your-profile `
  --payload '{"target_date":"2026-08-20"}' --cli-binary-format raw-in-base64-out `
  response.json
Get-Content response.json
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

## Querying the logs

Open the Athena console, select workgroup **portfolio-logs** and database **portfolio_logs**,
then either write ad hoc SQL or run one of the saved queries under **Saved queries**:

| Saved query | What it shows |
|---|---|
| `top-pages-last-7-days` | Most-requested URI paths, last 7 days |
| `likely-human-vs-bot-traffic` | Rough bot vs. human split by user-agent pattern matching |
| `traffic-by-day` | Requests and unique IPs per day |
| `status-code-breakdown` | Request counts by HTTP status |
| `top-referrers` | Where traffic is coming from |

These run against `cloudfront_logs` (raw). For faster, cheaper queries once a few days of
history have accumulated, query `cloudfront_logs_optimized` instead — same columns, plus
`year`/`month`/`day` partition columns to filter on; the ETL Lambda only backfills partitions
you've explicitly asked it to (or the previous day, automatically, every night at 06:00 UTC).

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
    athena-stack.ts           Glue database/tables, Athena workgroup, ETL Lambda, schedule, alarm
  lambda/
    contact/
      handler.py              Contact form Lambda function
    log-etl/
      handler.py              Converts raw CloudFront logs to partitioned Parquet, emails a daily summary
  website/
    resume/
      index.html              Digital CV page
  scripts/
    setup-ssm-params.ps1      Creates SSM parameters before first deploy
  zone.txt                    Gitignored — exported zone file from registrar
  cdk.json.example            Safe to commit — copy to cdk.json and fill in values
  cdk.json                    Gitignored — contains domain name, CloudFront ARN, pandas layer ARN
  .gitignore
  README.md
  package.json
  tsconfig.json
```

## Security

- S3 website bucket has all public access blocked
- CloudFront accesses S3 via Origin Access Control — no direct S3 access possible
- CloudFront's redirect function allowlists the two real routes (`/`, `/resume`) and known
  static-asset extensions; everything else is rejected at the edge before reaching S3 —
  stops vulnerability-scanner probes (`/wp-*`, `*.php`, `/.env`, etc.) without needing a
  maintained blocklist
- Security headers enforced on all CloudFront responses
- Contact form rate limited at API Gateway — 10 requests per second
- API Gateway endpoint proxied through CloudFront — never exposed in HTML source
- Sensitive values stored in SSM Parameter Store — never in code or GitHub
- HTTPS enforced via CloudFront viewer protocol policy
- ACM wildcard certificate covers apex domain and all subdomains
- S3 and CloudFront access logs written to a dedicated logging bucket
- Logs expire automatically after 90 days
- Athena query-results bucket blocks all public access, same as the website bucket
- The ETL Lambda's IAM role is scoped to only the specific S3 prefixes, Glue table, and
  Athena workgroup it needs — not broad account-wide access
- CloudWatch alarm on the ETL Lambda's errors notifies `/portfolio/alert-email` if the
  nightly job fails, rather than failing silently

## Cost estimate

| Service | Estimated monthly cost |
|---|---|
| Route 53 hosted zone | ~$0.50 |
| S3 | ~$0.00 |
| CloudFront | ~$0.00 |
| Lambda | ~$0.00 |
| API Gateway | ~$0.00 |
| SES | ~$0.00 |
| Athena / Glue | ~$0.00–0.01 (queries stay well under the workgroup's 1 GB per-query scan cap) |
| Athena ETL Lambda + EventBridge | ~$0.00 (well within Lambda free tier at this traffic volume) |
| CloudWatch alarm | ~$0.10 |
| **Total** | **~$0.60/month** |

A monthly AWS Budget alert is deployed at $5 to catch anything unexpected.
