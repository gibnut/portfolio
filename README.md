# portfolio

AWS CDK infrastructure for a personal digital CV and portfolio site.

## Architecture

```
GoDaddy DNS
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
```

## Stacks

| Stack | Resources |
|---|---|
| `PortfolioCertificateStack` | ACM wildcard certificate |
| `PortfolioStorageStack` | S3 bucket, static asset deployment |
| `PortfolioCDNStack` | CloudFront distribution, OAC, redirect function, security headers |
| `PortfolioAPIStack` | Lambda contact form, API Gateway, SES |

## Prerequisites

- Node.js 18+
- AWS CDK v2: `npm install -g aws-cdk`
- AWS CLI configured with a named profile
- CDK bootstrapped: `cdk bootstrap aws://ACCOUNT_ID/us-east-1 --profile YOUR_PROFILE`

## Setup

### 1. Clone and install dependencies

```bash
git clone https://github.com/yourusername/portfolio.git
cd portfolio
npm install
```

### 2. Configure CDK context

```bash
cp cdk.json.example cdk.json
```

Edit `cdk.json` and set your domain name:

```json
{
  "context": {
    "domainName": "your-domain.com"
  }
}
```

`cdk.json` is gitignored and will not be committed.

### 3. Create SSM parameters

Sensitive values are stored in AWS SSM Parameter Store — never in code or GitHub.

Run the setup script:

```powershell
.\scripts\setup-ssm-params.ps1 -FromEmail "you@yourdomain.com" -ToEmail "you@yourdomain.com" -Profile "your-profile"
```

This creates:
- `/portfolio/contact-email-from`
- `/portfolio/contact-email-to`

### 4. Verify your email in SES

Before the contact form will send email, verify your FROM address in AWS SES:

```bash
aws ses verify-email-identity --email-address you@yourdomain.com --profile your-profile
```

Check your inbox and click the verification link.

### 5. Deploy

Deploy all stacks in dependency order:

```bash
# Set your profile for the session
$env:AWS_PROFILE = "your-profile"

# Deploy certificate first — CloudFront requires it
cdk deploy PortfolioCertificateStack

# Add DNS validation CNAME to GoDaddy (see stack output)
# Wait for certificate to reach Issued status in ACM

# Deploy remaining stacks
cdk deploy PortfolioStorageStack
cdk deploy PortfolioCDNStack
cdk deploy PortfolioAPIStack

# Or deploy all at once after certificate is validated
cdk deploy --all
```

### 6. Configure DNS in GoDaddy

After deploying `PortfolioCDNStack`, check the stack outputs for the CloudFront domain name. Add CNAME records in GoDaddy:

| Type | Name | Value |
|---|---|---|
| CNAME | `@` or root | CloudFront domain |
| CNAME | `www` | CloudFront domain |
| CNAME | `resume` | CloudFront domain |

### 7. Update contact form endpoint

After deploying `PortfolioAPIStack`, copy the API endpoint from the stack output and update the `ENDPOINT` constant in `website/resume/index.html`.

## Project Structure

```
portfolio/
  bin/
    app.ts                  CDK app entry point
  lib/
    certificate-stack.ts    ACM wildcard certificate
    storage-stack.ts        S3 bucket and asset deployment
    cdn-stack.ts            CloudFront, OAC, redirect function
    api-stack.ts            Lambda, API Gateway, SES
  lambda/
    contact/
      handler.py            Contact form Lambda function
  website/
    resume/
      index.html            Portfolio page
  scripts/
    setup-ssm-params.ps1   Creates SSM parameters before first deploy
  cdk.json.example          Safe to commit — copy to cdk.json and fill in values
  cdk.json                  Gitignored — contains your real domain name
  .gitignore
  README.md
  package.json
  tsconfig.json
```

## Security

- S3 bucket has all public access blocked
- CloudFront accesses S3 via Origin Access Control only
- Security headers enforced on all responses
- Contact form rate limited at API Gateway
- Sensitive values stored in SSM Parameter Store — never in code or GitHub
- HTTPS enforced via CloudFront viewer protocol policy
- ACM certificate covers apex and all subdomains

## Cost estimate

All services stay within AWS free tier for a personal site with typical traffic:

| Service | Estimated monthly cost |
|---|---|
| S3 | ~$0.00 |
| CloudFront | ~$0.00 |
| Lambda | ~$0.00 |
| API Gateway | ~$0.00 |
| Route 53 hosted zone (future) | ~$0.50 |
| **Total** | **~$0.50/month** |

Set up an AWS Budget alert at $5/month to catch anything unexpected.
