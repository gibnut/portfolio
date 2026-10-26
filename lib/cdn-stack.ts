import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as fs from 'fs';
import * as path from 'path';
import { Construct } from 'constructs';
import { logRetention } from './common/utils/retention';
import { CONTACT_PATH } from './api-stack';

interface PortfolioCDNStackProps extends cdk.StackProps {
  domainName: string;
  // Physical-resource-name prefix (bin/app.ts)
  projectSlug: string;
  bucketName: string;
  bucketArn: string;
  // Dedicated logging bucket name; receives CloudFront access logs. Separate
  // from the website bucket so BucketDeployment never prunes log files.
  loggingBucketName: string;
  certificate: acm.ICertificate;
  apiOriginDomain: string;
  // The app-wide retention period (bin/app.ts), for the website-upload helper's log group
  retentionDays: number;
}

// Files generated at deploy time from templates/, with {{domainName}}
// filled in from cdk.json, so the real domain never appears in the public repo.
const GENERATED_FILES = ['robots.txt', 'sitemap.xml'];

export class PortfolioCDNStack extends cdk.Stack {
  public readonly distributionDomainName: string;

  constructor(scope: Construct, id: string, props: PortfolioCDNStackProps) {
    super(scope, id, props);

    const { domainName, projectSlug, bucketName, bucketArn, loggingBucketName, certificate, apiOriginDomain, retentionDays } = props;

    // Import the website bucket by name/ARN. Avoids a cross-stack object
    // reference that would create a dependency cycle.
    const bucket = s3.Bucket.fromBucketAttributes(this, 'ImportedBucket', {
      bucketName,
      bucketArn,
    });

    // CloudFront access logs are written to the logging bucket under cloudfront-logs/
    const loggingBucket = s3.Bucket.fromBucketName(this, 'ImportedLoggingBucket', loggingBucketName);

    // Discover valid page routes from the website/ folder's actual contents at
    // synth time, rather than hand-maintaining a route list inside the edge
    // function below. Two conventions are supported, per route:
    //   - website/resume/index.html -> /resume (directory style)
    //   - website/resume.html       -> /resume (flat-file style)
    // This keeps the edge function's strict default-deny behavior (only
    // known-good routes and recognized asset extensions ever reach S3) while a
    // new page only needs its file or folder created. index.html itself is the
    // homepage, served at root, not a named route.
    // Single level only: nested sub-routes (e.g. /resume/archive) aren't picked
    // up; extend to a recursive walk if the site grows that kind of structure.
    const websiteDir = path.join(__dirname, '..', 'website');
    const routeMap: Record<string, string> = {};
    if (fs.existsSync(websiteDir)) {
      const entries = fs.readdirSync(websiteDir, { withFileTypes: true });
      for (const entry of entries) {
        // '404' is skipped so /404 isn't a live route returning 200 OK. The page
        // is still served, with a real 404 status, by the edge function and
        // errorResponses below.
        if (entry.isDirectory() && entry.name !== '404' && fs.existsSync(path.join(websiteDir, entry.name, 'index.html'))) {
          routeMap[entry.name] = `/${entry.name}/index.html`;
        }
      }
      for (const entry of entries) {
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.html') && entry.name.toLowerCase() !== 'index.html') {
          routeMap[entry.name.slice(0, -'.html'.length)] = `/${entry.name}`;
        }
        // robots.txt and sitemap.xml are generated (see GENERATED_FILES). A
        // copy left in website/ would contain the real domain in the public
        // repo and would compete with the generated file.
        if (entry.isFile() && GENERATED_FILES.includes(entry.name)) {
          throw new Error(`website/${entry.name} must not exist: it is generated from templates/${entry.name} at deploy time. Delete it (git rm website/${entry.name}).`);
        }
      }
    } else {
      console.warn('WARNING: ./website not found at synth time. The CDN will deploy with only the root route allowed until it exists.');
    }

    // Branded 404 page, embedded in the edge function so a person who mistypes
    // a URL sees the real page while the request still never reaches S3. Read
    // from website/404/index.html at synth time (single source of truth).
    // Indentation and HTML comments are stripped only to save bytes, because
    // CloudFront Functions have a 10 KB code-size limit (checked below).
    const notFoundPagePath = path.join(websiteDir, '404', 'index.html');
    const notFoundHtml = fs.existsSync(notFoundPagePath)
      ? fs.readFileSync(notFoundPagePath, 'utf8').replace(/<!--[\s\S]*?-->/g, '').replace(/\n\s+/g, '\n')
          // Non-ASCII characters (e.g. an em dash in the heading) become HTML
          // numeric references, so the page renders the same but the
          // CloudFormation template stays ASCII (see the check in bin/app.ts).
          .replace(/[^\x00-\x7f]/g, (c) => `&#${c.codePointAt(0)};`)
      : 'Not Found';
    const notFoundContentType = fs.existsSync(notFoundPagePath) ? 'text/html; charset=utf-8' : 'text/plain';

    // Canonical page URLs are the clean forms ('/', '/resume'). A request for a
    // page's file name ('/index.html', '/resume/index.html', or a flat
    // '/name.html') gets a 301 to that clean URL, so each page has exactly one
    // URL for search engines. Built from the same scan as routeMap; the 404
    // folder isn't in routeMap, so '/404/index.html' (which errorResponses use)
    // is never redirected.
    const pageRedirects: Record<string, string> = { '/index.html': '/' };
    for (const [routeName, key] of Object.entries(routeMap)) {
      pageRedirects[key] = `/${routeName}`;
    }

    // Everything inside this template literal ends up in the CloudFormation
    // template, comments included, so it must stay ASCII (bin/app.ts checks).
    const redirectFunctionCode = `
// Rebuilds the viewer's query string for a redirect. Values arrive already
// percent-encoded, so they're joined as-is; encoding them again would
// double-encode.
function queryString(request) {
  var qs = [];
  for (var key in request.querystring) {
    var item = request.querystring[key];
    if (item.multiValue) {
      for (var m = 0; m < item.multiValue.length; m++) {
        qs.push(key + '=' + item.multiValue[m].value);
      }
    } else {
      qs.push(key + '=' + item.value);
    }
  }
  return qs.length ? '?' + qs.join('&') : '';
}

function redirect(path, request) {
  return {
    statusCode: 301,
    statusDescription: 'Moved Permanently',
    headers: { location: { value: 'https://${domainName}' + path + queryString(request) } }
  };
}

function handler(event) {
  var request = event.request;
  var host = request.headers.host ? request.headers.host.value : '';
  var uri = request.uri;

  // Known-good page routes, generated at synth time from website/ (see
  // cdn-stack.ts). Maps a route name to the S3 key it serves.
  var routeMap = ${JSON.stringify(routeMap)};
  // Page file name -> canonical clean URL (also generated in cdn-stack.ts).
  var pageRedirects = ${JSON.stringify(pageRedirects)};
  var isPageFile = Object.prototype.hasOwnProperty.call(pageRedirects, uri);
  var isSlashRoute = uri.length > 1 && uri.charAt(uri.length - 1) === '/' &&
    Object.prototype.hasOwnProperty.call(routeMap, uri.slice(1, -1));

  // www -> apex, path and query string kept. A page's file name or
  // trailing-slash form goes straight to its clean URL: one redirect, not two.
  if (host === 'www.${domainName}') {
    return redirect(isPageFile ? pageRedirects[uri] : (isSlashRoute ? uri.slice(0, -1) : uri), request);
  }

  // resume subdomain -> the resume page on the apex.
  if (host === 'resume.${domainName}') {
    return redirect('/resume', request);
  }

  // Reject dev-tooling/build-system paths outright. These are universal
  // source-code conventions, never present in a deployed static site, so the
  // list doesn't change as pages or assets are added.
  var blockedPrefixes = [
    '/src/', '/node_modules/', '/vendor/', '/.git/', '/.aws/', '/.ssh/', '/cgi-bin/', '/wp-'
  ];
  for (var p = 0; p < blockedPrefixes.length; p++) {
    if (uri.indexOf(blockedPrefixes[p]) === 0) {
      return {
        statusCode: 404,
        statusDescription: 'Not Found',
        headers: { 'content-type': { value: 'text/plain' } },
        body: { encoding: 'text', data: 'Not Found' }
      };
    }
  }

  // A page's file name (e.g. /resume/index.html) -> 301 to its clean URL.
  // Checked before the asset allowlist, which would otherwise pass .html
  // straight to S3.
  if (isPageFile) {
    return redirect(pageRedirects[uri], request);
  }

  // Static asset allowlist: these extensions pass through as-is. S3 returns
  // 404 if the specific file doesn't exist; this only keeps non-asset paths
  // from reaching the origin at all.
  var allowedExtensions = [
    '.html', '.css', '.js', '.mjs', '.json',
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico',
    '.woff', '.woff2', '.ttf', '.eot',
    '.pdf', '.xml', '.txt', '.webmanifest', '.map'
  ];
  var lower = uri.toLowerCase();
  for (var i = 0; i < allowedExtensions.length; i++) {
    if (lower.indexOf(allowedExtensions[i], lower.length - allowedExtensions[i].length) !== -1) {
      return request;
    }
  }

  // Strip a single trailing slash for route matching. Root '/' becomes ''.
  var routePath = uri;
  if (routePath.charAt(routePath.length - 1) === '/') {
    routePath = routePath.slice(0, -1);
  }

  if (routePath === '') {
    request.uri = '/index.html';
    return request;
  }
  var routeName = routePath.slice(1);
  if (Object.prototype.hasOwnProperty.call(routeMap, routeName)) {
    // A trailing slash (/resume/) is a second URL for the same page; send it
    // to the canonical form (/resume).
    if (routePath !== uri) {
      return redirect(routePath, request);
    }
    request.uri = routeMap[routeName];
    return request;
  }

  // Not root, not a known route, not a recognized asset extension: never
  // reaches S3. People who mistype a URL land here too, so this returns the
  // branded 404 page (embedded at synth time). The blockedPrefixes reject
  // above stays plain text, since only scanners request those paths.
  return {
    statusCode: 404,
    statusDescription: 'Not Found',
    headers: {
      'content-type': { value: '${notFoundContentType}' },
      'cache-control': { value: 'no-store' }
    },
    body: { encoding: 'text', data: ${JSON.stringify(notFoundHtml)} }
  };
}
`;

    // CloudFront Functions reject code over 10 KB at deploy time. Fail at synth
    // instead, with a clear message.
    const redirectFunctionBytes = Buffer.byteLength(redirectFunctionCode, 'utf8');
    if (redirectFunctionBytes > 10000) {
      throw new Error(`redirectFunction code is ${redirectFunctionBytes} bytes; CloudFront Functions allow 10 KB. Trim website/404/index.html or the function comments.`);
    }

    const redirectFunction = new cloudfront.Function(this, 'RedirectFunction', {
      functionName: `${projectSlug}-redirects`,
      // www -> apex and resume subdomain -> /resume redirects (query string
      // kept); 301s a page's file name or trailing-slash form to its clean URL;
      // blocks known dev-tooling paths with a plain-text 404; passes recognized
      // static-asset extensions through; resolves root and each route in
      // routeMap to its S3 key. Everything else gets the embedded branded 404
      // at the edge and never reaches S3. That strictness is deliberate: bots
      // find a domain and start probing within moments of its certificate
      // issuing (Certificate Transparency logs are public and watched), and
      // this keeps that traffic away from the origin.
      comment: 'www and resume redirects + strict edge allowlist for known routes/assets',
      code: cloudfront.FunctionCode.fromInline(redirectFunctionCode),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    });

    const oac = new cloudfront.S3OriginAccessControl(this, 'OAC', {
      description: `${projectSlug} OAC for S3 bucket access`,
    });

    const securityHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: {
          frameOption: cloudfront.HeadersFrameOption.DENY,
          override: true,
        },
        // No X-XSS-Protection: OWASP recommends not setting it (browsers have
        // removed the filter, and it could create XSS issues in old ones).
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
      },
    });

    const apiOrigin = new origins.HttpOrigin(apiOriginDomain, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    });

    const apiCachePolicy = new cloudfront.CachePolicy(this, 'APICachePolicy', {
      cachePolicyName: `${projectSlug}-api-no-cache`,
      defaultTtl: cdk.Duration.seconds(0),
      minTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.seconds(0),
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: projectSlug,
      domainNames: [
        domainName,
        `www.${domainName}`,
        `resume.${domainName}`,
      ],
      certificate,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket, {
          originAccessControl: oac,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeadersPolicy,
        functionAssociations: [{
          function: redirectFunction,
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        }],
      },
      additionalBehaviors: {
        // Exact path, no wildcard: other /api/... probes still go through the
        // edge function's default-deny instead of reaching API Gateway.
        [CONTACT_PATH]: {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: apiCachePolicy,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: securityHeadersPolicy,
        },
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 404,
          responsePagePath: '/404/index.html',
          ttl: cdk.Duration.minutes(5),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 404,
          responsePagePath: '/404/index.html',
          ttl: cdk.Duration.minutes(5),
        },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      enableIpv6: true,
      enableLogging: true,
      logBucket: loggingBucket,
      logFilePrefix: 'cloudfront-logs/',
    });

    // CDK warns that it can't add the OAC bucket policy to an imported bucket.
    // That's by design: PortfolioStorageStack attaches it, scoped to the ARN in
    // cdk.json (cloudfrontDistributionArn), and warns at synth if that ARN isn't
    // set. The case this acknowledgment hides: a distribution that's replaced
    // (new ARN) while cdk.json still has the old one. The site would then return
    // the 404 page everywhere until cdk.json is updated and the storage stack
    // redeployed.
    cdk.Annotations.of(distribution).acknowledgeWarning(
      '@aws-cdk/aws-cloudfront-origins:updateImportedBucketPolicyOac',
      'OAC bucket policy is attached by PortfolioStorageStack (see storage-stack.ts)',
    );

    // Log group for BucketDeployment's CDK helper Lambda, which runs the upload
    // on every deploy. Without it, Lambda creates a log group on first run that
    // never expires. bin/app.ts fails synth if any Lambda lacks a log group.
    const deployWebsiteLogGroup = new logs.LogGroup(this, 'DeployWebsiteLogs', {
      logGroupName: `/aws/lambda/${projectSlug}-cdk-website-deploy`,
      retention: logRetention(retentionDays),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // robots.txt and sitemap.xml: read each template, replace every
    // {{domainName}} with the real domain from cdk.json, and add the result to
    // the website upload under the same file name, at the bucket root. A
    // missing template fails synth, so the live file can't silently disappear.
    const templatesDir = path.join(__dirname, '..', 'templates');
    const generatedSources = GENERATED_FILES.map((name) => {
      const templatePath = path.join(templatesDir, name);
      if (!fs.existsSync(templatePath)) {
        throw new Error(`templates/${name} not found. It is the source for /${name} on the site (see README, "Content updates").`);
      }
      const content = fs.readFileSync(templatePath, 'utf8').split('{{domainName}}').join(domainName);
      return s3deploy.Source.data(name, content);
    });

    // BucketDeployment syncs website files to S3. prune (the default) only
    // affects the website bucket, which holds nothing but website files.
    new s3deploy.BucketDeployment(this, 'DeployWebsite', {
      sources: [s3deploy.Source.asset('./website'), ...generatedSources],
      destinationBucket: bucket,
      logGroup: deployWebsiteLogGroup,
      cacheControl: [
        s3deploy.CacheControl.fromString('max-age=300, must-revalidate'),
      ],
    });

    this.distributionDomainName = distribution.distributionDomainName;

    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: distribution.distributionDomainName,
      description: `CloudFront distribution domain - store in SSM /${projectSlug}/cloudfront-domain for the DNS stack`,
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: distribution.distributionId,
      description: 'CloudFront distribution ID - use for cache invalidation after deploys',
    });

    new cdk.CfnOutput(this, 'DistributionArnNote', {
      value: `Add the CloudFront distribution ARN to cdk.json (cloudfrontDistributionArn), then redeploy PortfolioStorageStack to apply the OAC bucket policy`,
      description: 'Post-deploy step required after the first CDN deployment',
    });

    new cdk.CfnOutput(this, 'ContactEndpointNote', {
      value: `Contact form endpoint in HTML: https://${domainName}${CONTACT_PATH} - API Gateway URL never exposed`,
      description: 'CloudFront proxy hides the real API Gateway endpoint',
    });
  }
}
