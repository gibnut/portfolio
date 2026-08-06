# setup-ssm-params.ps1
# Run this script once before your first cdk deploy
# Creates required SSM parameters in your AWS account
# These values never touch GitHub

param(
  [Parameter(Mandatory=$true)]
  [string]$FromEmail,

  [Parameter(Mandatory=$true)]
  [string]$ToEmail,

  [Parameter(Mandatory=$false)]
  [string]$Profile = "personal"
)

Write-Host "Creating SSM parameters for portfolio..." -ForegroundColor Cyan

# Email address SES sends FROM
# Stored as String — CloudFormation does not support SecureString references
aws ssm put-parameter `
  --name "/portfolio/contact-email-from" `
  --value $FromEmail `
  --type "String" `
  --description "portfolio contact form FROM email address" `
  --overwrite `
  --profile $Profile

if ($LASTEXITCODE -ne 0) {
  Write-Host "Failed to create FROM email parameter" -ForegroundColor Red
  exit 1
}

# Email address contact form submissions are sent TO
aws ssm put-parameter `
  --name "/portfolio/contact-email-to" `
  --value $ToEmail `
  --type "String" `
  --description "portfolio contact form TO email address" `
  --overwrite `
  --profile $Profile

if ($LASTEXITCODE -ne 0) {
  Write-Host "Failed to create TO email parameter" -ForegroundColor Red
  exit 1
}

Write-Host "SSM parameters created successfully." -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Deploy stacks: cdk deploy --all --profile $Profile"
Write-Host "  2. After PortfolioAPIStack deploys, add the three SES DKIM CNAME records to GoDaddy"
Write-Host "  3. After PortfolioCDNStack deploys, add CloudFront CNAME records to GoDaddy"
Write-Host "  4. Update website/resume/index.html ENDPOINT to https://yourdomain.com/contact"
