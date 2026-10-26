# setup-ssm-params.ps1
# Run once before the first cdk deploy into an account.
# Creates the SSM parameters the stacks read. These values never touch GitHub.

param(
  [Parameter(Mandatory=$true)]
  [string]$FromEmail,

  [Parameter(Mandatory=$true)]
  [string]$ToEmail,

  [Parameter(Mandatory=$true)]
  [string]$AlertEmail,

  [Parameter(Mandatory=$false)]
  [string]$Profile = "personal"
)

function Put-Param([string]$Name, [string]$Value, [string]$Description) {
  # Stored as String: CloudFormation can't resolve SecureString parameters here
  aws ssm put-parameter `
    --name $Name `
    --value $Value `
    --type "String" `
    --description $Description `
    --overwrite `
    --profile $Profile | Out-Null

  if ($LASTEXITCODE -ne 0) {
    Write-Host "Failed to create $Name" -ForegroundColor Red
    exit 1
  }
  Write-Host "  $Name" -ForegroundColor Green
}

$account = aws sts get-caller-identity --profile $Profile --query Account --output text
if ($LASTEXITCODE -ne 0) {
  Write-Host "Could not reach AWS with profile '$Profile'. Run: aws sso login --profile $Profile" -ForegroundColor Red
  exit 1
}
Write-Host "Creating SSM parameters for portfolio in account $account (profile $Profile)..." -ForegroundColor Cyan

# Address SES sends FROM (must be on the SES-verified domain)
Put-Param "/portfolio/contact-email-from" $FromEmail "portfolio contact form FROM email address"

# Address contact form submissions are sent TO
Put-Param "/portfolio/contact-email-to" $ToEmail "portfolio contact form TO email address"

# Address for the ETL failure alarm and the daily traffic summary email
Put-Param "/portfolio/alert-email" $AlertEmail "portfolio alert and daily report email address"

Write-Host ""
Write-Host "SSM parameters created." -ForegroundColor Green
Write-Host ""
Write-Host "Next steps (README.md, 'Deploy'):" -ForegroundColor Yellow
Write-Host "  1. Deploy PortfolioCertificateStack, then add its DNS validation CNAME to the live DNS zone"
Write-Host "  2. After PortfolioCDNStack deploys, store its domain in /portfolio/cloudfront-domain"
Write-Host "  3. Add the three SES DKIM CNAMEs from PortfolioAPIStack's outputs to zone.txt"
