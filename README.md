# portfolio

AWS CDK (TypeScript) infrastructure for a personal digital CV and portfolio site.

## Architecture

```
Route 53 DNS (hosted zone, A + AAAA aliases for apex, www, resume)
    └── CloudFront Distribution
            ├── Edge function (CloudFront Functions)
            │     www -> apex, resume subdomain -> /resume, one clean URL per page,
            │     strict allowlist: unknown paths get the branded 404 at the edge
            ├── Security headers
            ├── /api/contact -> API Gateway (exact path, never cached)
            └── S3 origin (private bucket via OAC)
                    └── website/ + generated robots.txt and sitemap.xml

Contact form
    └── API Gateway (portfolio-api, rate limited)
            └── Lambda (portfolio-contact-form)
                    └── SES -> your email

Logging (logging bucket, everything expires after retentionDays)
    ├── s3-access-logs/            S3 access logs
    ├── cloudfront-logs/           raw CloudFront access logs
    └── cloudfront-logs-optimized/ partitioned Parquet, written by the ETL Lambda

Log analysis
    └── Athena / Glue (portfolio_logs database)
            ├── cloudfront_logs            raw, queries the logs above directly
            ├── cloudfront_logs_optimized  partitioned Parquet, faster and cheaper
            └── Lambda (portfolio-log-etl), daily via EventBridge
                    ├── raw logs -> Parquet, registers the day's partition
                    └── SES -> daily traffic summary email
```

## Stacks

| Stack | Resources | Termination protection |
|---|---|---|
| `PortfolioCertificateStack` | ACM wildcard certificate (apex + `*`) | Yes |
| `PortfolioStorageStack` | S3 website bucket (versioned, old versions expire), logging bucket | Yes |
| `PortfolioAPIStack` | Contact Lambda, HTTP API, SES domain identity | Yes |
| `PortfolioCDNStack` | CloudFront distribution, OAC, edge function, security headers, website deployment | Yes |
| `PortfolioDNSStack` | Route 53 hosted zone, alias records, zone file import, shared zone parameters | Yes |
| `PortfolioAthenaStack` | Glue database and tables, Athena workgroup and saved queries, ETL Lambda, schedule, alarm | No |

Termination protection only blocks deleting a stack; deploys and updates are unaffected. To delete a
protected stack, turn it off first:
`aws cloudformation update-termination-protection --no-enable-termination-protection --stack-name <name> --profile <profile>`.

## Built-in checks

`bin/app.ts` fails `cdk synth` (and therefore every deploy) when:

- `accountId` in `cdk.json` isn't a real 12-digit account ID. Every stack is pinned to that account,
  so the CLI refuses to deploy with credentials for any other account.
- `domainName` isn't set, or an optional ARN in `cdk.json` is a leftover placeholder.
- `retentionDays` isn't a value CloudWatch log groups accept.
- Any template contains a non-ASCII character (CloudFormation stores them mangled, and `cdk diff`
  then reports phantom changes).
- Any Lambda, including CDK's own helper Lambdas, has no log group with a retention period.
- The edge function would exceed CloudFront Functions' 10 KB limit.
- `website/robots.txt` or `website/sitemap.xml` exists (they are generated; see below).

## Prerequisites

- Node.js 20+
- AWS CDK v2: `npm install -g aws-cdk`
- AWS CLI v2 with an IAM Identity Center (SSO) profile for the target account
- CDK bootstrapped in the target account: `cdk bootstrap aws://ACCOUNT_ID/us-east-1 --profile YOUR_PROFILE`

## Setup

### 1. Clone and install dependencies

```powershell
git clone https://github.com/yourusername/portfolio.git
cd portfolio
npm install
```

### 2. Configure CDK context

```powershell
Copy-Item cdk.json.example cdk.json
```

Edit `cdk.json` (gitignored, never committed):

```json
"context": {
  "accountId": "123456789012",
  "domainName": "your-domain.com",
  "cloudfrontDistributionArn": "",
  "pandasLayerArn": ""
}
```

- `accountId`: the AWS account every stack deploys to, in quotes.
- `cloudfrontDistributionArn`: leave `""` until after the first CDN deploy (step 5).
- `pandasLayerArn`: the AWS-managed pandas layer for the ETL Lambda. While it's `""`, the Athena stack
  is skipped and everything else deploys normally. The layer is versioned and AWS retires old versions,
  so look up the current one: Lambda console -> **Layers** -> **Add a layer** -> **AWS layers** ->
  search `AWSSDKPandas-Python312` -> copy the ARN for your region.

Update `cdk.json.example` too when you add a context key.

### 3. Create SSM parameters

Sensitive values live in SSM Parameter Store, never in code:

```powershell
.\scripts\setup-ssm-params.ps1 -FromEmail "noreply@yourdomain.com" -ToEmail "you@yourdomain.com" -AlertEmail "you@yourdomain.com" -Profile "your-profile"
```

| Parameter | Created by |
|---|---|
| `/portfolio/contact-email-from` | setup script |
| `/portfolio/contact-email-to` | setup script |
| `/portfolio/alert-email` | setup script (ETL failure alarm and daily report) |
| `/portfolio/cloudfront-domain` | you, after the first CDN deploy (step 5) |
| `/portfolio/certificate-arn` | `PortfolioCertificateStack` |
| `/shared/hosted-zone-id`, `/shared/hosted-zone-name` | `PortfolioDNSStack`, for other apps in the account |

### 4. Prepare the DNS zone file

The DNS stack reads `zone.txt` (gitignored) from the project root at synth time. Supported record
types: A, AAAA, CNAME, MX, TXT, CAA, SRV. Anything else produces a synth warning instead of being
dropped silently. SOA and NS records are skipped (Route 53 manages them), and A, AAAA and CNAME
records for the apex, `www` and `resume` are skipped because those names are CloudFront aliases.

`zone.txt` must also hold the ACM validation CNAME (step 5) and the three SES DKIM CNAMEs
(`PortfolioAPIStack` outputs).

### 5. Deploy

```powershell
aws sso login --sso-session org
$p = "your-profile"

cdk diff --profile $p

# 1. Certificate. Add the validation CNAME shown in the ACM console to the DNS zone that is
#    currently live (and to zone.txt), and wait for the status Issued.
cdk deploy PortfolioCertificateStack --profile $p

# 2. Storage and API
cdk deploy PortfolioStorageStack PortfolioAPIStack --profile $p

# 3. CDN (needs the certificate Issued)
cdk deploy PortfolioCDNStack --profile $p

# 4. After the CDN deploys:
#    - put the distribution ARN into cdk.json (cloudfrontDistributionArn)
#    - store the distribution domain for the DNS stack:
aws ssm put-parameter --name "/portfolio/cloudfront-domain" --value "d1234abcd.cloudfront.net" --type String --overwrite --profile $p
#    - redeploy storage to attach the OAC bucket policy
cdk deploy PortfolioStorageStack --profile $p

# 5. DNS: hosted zone, aliases, zone.txt records. Then point the registrar's nameservers at the
#    four Route 53 nameservers in the stack output.
cdk deploy PortfolioDNSStack --profile $p

# 6. Athena (needs pandasLayerArn in cdk.json)
cdk deploy PortfolioAthenaStack --profile $p
```

Test the ETL pipeline without waiting for the 06:00 UTC schedule:

```powershell
aws lambda invoke --function-name portfolio-log-etl --profile $p `
  --payload '{"target_date":"2026-08-20"}' --cli-binary-format raw-in-base64-out response.json
Get-Content response.json
```

### 6. Contact form endpoint

The form posts to `https://yourdomain.com/api/contact`. CloudFront proxies that exact path to API
Gateway, so the API Gateway URL never appears in the HTML. The path is `CONTACT_PATH` in
`lib/api-stack.ts`; the form's `ENDPOINT` constant in `website/resume/index.html` must match it.

### 7. Content updates

Edit files under `website/`, then:

```powershell
cdk deploy PortfolioCDNStack --profile $p
aws cloudfront create-invalidation --distribution-id YOUR_DISTRIBUTION_ID --paths "/*" --profile $p
```

A new page is a new folder with an `index.html` (or a `name.html` file): the edge function's route list
is generated from `website/` at synth time. `robots.txt` and `sitemap.xml` are generated from
`templates/`, with `{{domainName}}` filled in from `cdk.json`, so the real domain never appears in
the repo.

## Querying the logs

In the Athena console, select workgroup **portfolio-logs** and database **portfolio_logs**, then
write SQL or run a saved query:

| Saved query | What it shows |
|---|---|
| `top-pages-last-7-days` | Most-requested URI paths, last 7 days |
| `bot-user-agents-vs-other` | Requests from self-identified bot user agents vs everything else (not a visitor count) |
| `traffic-by-day` | Requests and distinct IPs per day, bots included (not a visitor count) |
| `status-code-breakdown` | Request counts by HTTP status |
| `top-referrers` | Where traffic is coming from |

The saved queries read `cloudfront_logs` (raw). `cloudfront_logs_optimized` has the same columns
plus `year`/`month`/`day` partitions; the ETL Lambda adds the previous day every night at 06:00 UTC,
or any day you invoke it for.

## Project structure

```
portfolio/
  bin/
    app.ts                    CDK app entry point, shared settings, synth-time checks
  lib/
    certificate-stack.ts      ACM wildcard certificate
    storage-stack.ts          S3 website bucket and dedicated logging bucket
    api-stack.ts              Contact Lambda, API Gateway, SES domain verification
    cdn-stack.ts              CloudFront distribution, OAC, edge function, website deployment
    dns-stack.ts              Route 53 hosted zone, alias records, zone file parser
    athena-stack.ts           Glue tables, Athena workgroup and queries, ETL Lambda, schedule, alarm
    common/utils/
      retention.ts            Validates retentionDays against CloudWatch's allowed values
  lambda/
    contact/handler.py        Contact form Lambda
    log-etl/handler.py        Raw CloudFront logs -> partitioned Parquet, daily summary email
  website/
    index.html                Homepage
    404/index.html            Branded 404 page (also embedded in the edge function)
    resume/index.html         Digital CV
  templates/
    robots.txt                Template for /robots.txt
    sitemap.xml               Template for /sitemap.xml
  scripts/
    setup-ssm-params.ps1      Creates SSM parameters before the first deploy
  cdk.json.example            Committed; copy to cdk.json and fill in
  cdk.json                    Gitignored: account ID, domain name, ARNs
  zone.txt                    Gitignored: exported DNS zone file
```

## Security

- S3 buckets block all public access; CloudFront reads the website bucket only through OAC
- The edge function allowlists real routes and known static-asset extensions; everything else is
  answered at the edge and never reaches S3, so scanner probes (`/wp-*`, `*.php`, `/.env`) never touch
  the origin
- Security headers on all responses (HSTS, nosniff, frame DENY, strict referrer policy)
- Contact form rate limited at API Gateway (10 requests/second, burst 20) and proxied through CloudFront
- HTTPS enforced by the viewer protocol policy
- Sensitive values in SSM Parameter Store; account ID, domain and ARNs only in gitignored `cdk.json`
- Every stack pinned to one account; data-bearing stacks have termination protection
- Logs and old website file versions expire after `retentionDays` (90); Athena results after 30 days
- The ETL Lambda's IAM role is scoped to its S3 prefixes, Glue table and Athena workgroup
- A CloudWatch alarm emails `/portfolio/alert-email` if the nightly ETL job fails

## Cost estimate

| Service | Estimated monthly cost |
|---|---|
| Route 53 hosted zone | ~$0.50 |
| S3, CloudFront, Lambda, API Gateway, SES | ~$0.00 at this traffic |
| Athena / Glue | ~$0.00-0.01 (well under the 1 GB per-query scan cap) |
| CloudWatch alarm | ~$0.10 |
| **Total** | **~$0.60/month** |
