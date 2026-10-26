"""
portfolio-log-etl

Daily job:
1. Reads the previous day's raw CloudFront logs (gzip/TSV) from cloudfront-logs/
2. Converts them to Parquet, writes to cloudfront-logs-optimized/year=/month=/day=/
3. Registers that partition in Glue via an Athena DDL query (no crawler needed)
4. Runs a small summary query against the new partition and emails the result via SES

Triggered by an EventBridge scheduled rule (see athena-stack.ts). Can also be
invoked manually with {"target_date": "YYYY-MM-DD"} to backfill a specific day.
"""

import datetime
import gzip
import io
import os
import time

import boto3
import pandas as pd

s3 = boto3.client('s3')
athena = boto3.client('athena')
ses = boto3.client('ses')
ssm = boto3.client('ssm')

LOG_BUCKET = os.environ['LOG_BUCKET']
RAW_PREFIX = os.environ.get('RAW_PREFIX', 'cloudfront-logs/')
OPTIMIZED_PREFIX = os.environ.get('OPTIMIZED_PREFIX', 'cloudfront-logs-optimized/')
DATABASE = os.environ['GLUE_DATABASE']
OPTIMIZED_TABLE = os.environ['OPTIMIZED_TABLE']
WORKGROUP = os.environ['ATHENA_WORKGROUP']
RESULTS_BUCKET = os.environ['RESULTS_BUCKET']
ALERT_EMAIL_PARAM = os.environ['ALERT_EMAIL_PARAM']
FROM_EMAIL_PARAM = os.environ['FROM_EMAIL_PARAM']

# Matches the CloudFront standard log format — same column order as the raw
# Glue table in athena-stack.ts. Kept in sync manually; if that table's
# columns ever change, update this list too.
COLUMNS = [
    'date', 'time', 'x_edge_location', 'sc_bytes', 'c_ip', 'cs_method', 'cs_host',
    'cs_uri_stem', 'sc_status', 'cs_referer', 'cs_user_agent', 'cs_uri_query',
    'cs_cookie', 'x_edge_result_type', 'x_edge_request_id', 'x_host_header',
    'cs_protocol', 'cs_bytes', 'time_taken', 'x_forwarded_for', 'ssl_protocol',
    'ssl_cipher', 'x_edge_response_result_type', 'cs_protocol_version',
    'fle_status', 'fle_encrypted_fields', 'c_port', 'time_to_first_byte',
    'x_edge_detailed_result_type', 'sc_content_type', 'sc_content_len',
    'sc_range_start', 'sc_range_end',
]

# Explicit dtype for every column — never let pandas infer types from content.
# This is the fix for a real bug: sc_status (e.g. "200", "403") looks numeric,
# so pandas silently inferred int64 and wrote it into Parquet as INT64, while
# the Glue table declares it as string — Athena rejected the file outright
# (HIVE_BAD_DATA) since Parquet enforces physical types strictly, unlike the
# raw TSV table's more lenient SerDe. 'date' and 'c_port' carry the same risk
# for the same reason and are fixed here too, matching the corresponding
# Glue schema changes in athena-stack.ts (date -> string, c_port -> bigint).
DTYPE_MAP = {
    'date': 'string', 'time': 'string', 'x_edge_location': 'string',
    'sc_bytes': 'Int64', 'c_ip': 'string', 'cs_method': 'string', 'cs_host': 'string',
    'cs_uri_stem': 'string', 'sc_status': 'string', 'cs_referer': 'string',
    'cs_user_agent': 'string', 'cs_uri_query': 'string', 'cs_cookie': 'string',
    'x_edge_result_type': 'string', 'x_edge_request_id': 'string', 'x_host_header': 'string',
    'cs_protocol': 'string', 'cs_bytes': 'Int64', 'time_taken': 'float64',
    'x_forwarded_for': 'string', 'ssl_protocol': 'string', 'ssl_cipher': 'string',
    'x_edge_response_result_type': 'string', 'cs_protocol_version': 'string',
    'fle_status': 'string', 'fle_encrypted_fields': 'string', 'c_port': 'Int64',
    'time_to_first_byte': 'float64', 'x_edge_detailed_result_type': 'string',
    'sc_content_type': 'string', 'sc_content_len': 'Int64',
    'sc_range_start': 'Int64', 'sc_range_end': 'Int64',
}


def handler(event, context):
    target_date = (event or {}).get('target_date')
    if not target_date:
        target_date = (datetime.datetime.utcnow() - datetime.timedelta(days=1)).strftime('%Y-%m-%d')
    year, month, day = target_date.split('-')

    keys = _list_raw_keys_for_date(target_date)
    if not keys:
        print(f'No raw log files found for {target_date}; nothing to do.')
        return {'status': 'no_data', 'date': target_date}

    combined = _load_and_combine(keys)

    out_prefix = f'{OPTIMIZED_PREFIX}year={year}/month={month}/day={day}/'
    out_key = f'{out_prefix}{target_date}.parquet'
    buffer = io.BytesIO()
    combined.to_parquet(buffer, engine='pyarrow', index=False)
    s3.put_object(Bucket=LOG_BUCKET, Key=out_key, Body=buffer.getvalue())

    _register_partition(year, month, day, out_prefix)

    summary = _query_daily_summary(year, month, day)
    _send_report_email(target_date, summary)

    return {'status': 'ok', 'date': target_date, 'files_processed': len(keys)}


def _list_raw_keys_for_date(target_date):
    """CloudFront names files DISTRIBUTION_ID.YYYY-MM-DD-HH.UNIQUEID.gz — filter on the date segment."""
    paginator = s3.get_paginator('list_objects_v2')
    keys = []
    for page in paginator.paginate(Bucket=LOG_BUCKET, Prefix=RAW_PREFIX):
        for obj in page.get('Contents', []):
            fname = obj['Key'].rsplit('/', 1)[-1]
            parts = fname.split('.')
            if len(parts) >= 3 and parts[1].startswith(target_date):
                keys.append(obj['Key'])
    return keys


def _load_and_combine(keys):
    frames = []
    for key in keys:
        body = s3.get_object(Bucket=LOG_BUCKET, Key=key)['Body'].read()
        with gzip.GzipFile(fileobj=io.BytesIO(body)) as gz:
            # comment='#' skips the two CloudFront header lines regardless of
            # exact count, rather than a hardcoded skiprows=2. dtype=DTYPE_MAP
            # forces every column to its declared type up front — no inference.
            df = pd.read_csv(gz, sep='\t', comment='#', names=COLUMNS, na_values='-', dtype=DTYPE_MAP)
        frames.append(df)
    return pd.concat(frames, ignore_index=True)


def _register_partition(year, month, day, out_prefix):
    location = f's3://{LOG_BUCKET}/{out_prefix}'
    ddl = (
        f"ALTER TABLE {OPTIMIZED_TABLE} ADD IF NOT EXISTS "
        f"PARTITION (year='{year}', month='{month}', day='{day}') "
        f"LOCATION '{location}'"
    )
    _run_athena_query(ddl)


def _query_daily_summary(year, month, day):
    query = (
        "SELECT COUNT(*) AS requests, "
        "COUNT(DISTINCT c_ip) AS unique_ips, "
        "SUM(CASE WHEN sc_status LIKE '4%' OR sc_status LIKE '5%' THEN 1 ELSE 0 END) AS error_responses "
        f"FROM {OPTIMIZED_TABLE} "
        f"WHERE year='{year}' AND month='{month}' AND day='{day}'"
    )
    return _run_athena_query(query, wait_for_results=True)


def _run_athena_query(query, wait_for_results=False):
    qid = athena.start_query_execution(
        QueryString=query,
        QueryExecutionContext={'Database': DATABASE},
        WorkGroup=WORKGROUP,
        ResultConfiguration={'OutputLocation': f's3://{RESULTS_BUCKET}/query-results/'},
    )['QueryExecutionId']

    status = 'RUNNING'
    for _ in range(30):  # ~60s max wait — these are small daily queries
        status = athena.get_query_execution(QueryExecutionId=qid)['QueryExecution']['Status']['State']
        if status in ('SUCCEEDED', 'FAILED', 'CANCELLED'):
            break
        time.sleep(2)

    if status != 'SUCCEEDED':
        reason = athena.get_query_execution(QueryExecutionId=qid)['QueryExecution']['Status'].get('StateChangeReason', '')
        raise RuntimeError(f'Athena query did not succeed ({status}): {reason}')

    if wait_for_results:
        return athena.get_query_results(QueryExecutionId=qid)
    return None


def _send_report_email(target_date, result):
    to_addr = ssm.get_parameter(Name=ALERT_EMAIL_PARAM)['Parameter']['Value']
    from_addr = ssm.get_parameter(Name=FROM_EMAIL_PARAM)['Parameter']['Value']

    rows = result['ResultSet']['Rows'] if result else []
    if len(rows) < 2:
        body = f'No traffic summary available for {target_date} (no matching rows).'
    else:
        headers = [c.get('VarCharValue', '') for c in rows[0]['Data']]
        values = [c.get('VarCharValue', '0') for c in rows[1]['Data']]
        summary = dict(zip(headers, values))
        body = (
            f'CloudFront traffic summary for {target_date}\n\n'
            f"Requests:          {summary.get('requests', 'n/a')}\n"
            f"Unique IPs:        {summary.get('unique_ips', 'n/a')}\n"
            f"4xx/5xx responses: {summary.get('error_responses', 'n/a')}\n"
        )

    ses.send_email(
        Source=from_addr,
        Destination={'ToAddresses': [to_addr]},
        Message={
            'Subject': {'Data': f'Portfolio traffic report — {target_date}'},
            'Body': {'Text': {'Data': body}},
        },
    )
