import * as logs from 'aws-cdk-lib/aws-logs';

// One retention period for the whole app (set as retentionDays in bin/app.ts):
// Lambda log groups, the logging bucket, and old website file versions all keep
// data this long. CloudWatch log groups accept only fixed values (1, 3, 5, 7,
// 14, 30, 60, 90, 120, 150, 180, 365, ...), so the number must be one of
// those; this fails synth with the list if it isn't.
export function logRetention(days: number): logs.RetentionDays {
  const allowed = Object.values(logs.RetentionDays)
    .filter((v): v is number => typeof v === 'number' && v !== logs.RetentionDays.INFINITE)
    .sort((a, b) => a - b);
  if (!allowed.includes(days)) {
    throw new Error(`retentionDays is ${days}, but CloudWatch log groups only accept: ${allowed.join(', ')}. Pick one of those in bin/app.ts.`);
  }
  return days as logs.RetentionDays;
}
