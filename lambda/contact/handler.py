import json
import boto3
import os
import re

ses = boto3.client('ses', region_name=os.environ['SES_REGION'])

def is_valid_email(email: str) -> bool:
    return bool(re.match(r'^[^@\s]+@[^@\s]+\.[^@\s]+$', email))

def lambda_handler(event: dict, context: object) -> dict:
    headers = {
        'Access-Control-Allow-Origin': os.environ['ALLOWED_ORIGIN'],
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST,OPTIONS',
        'Content-Type': 'application/json'
    }

    # Handle CORS preflight
    if event.get('requestContext', {}).get('http', {}).get('method') == 'OPTIONS':
        return {'statusCode': 200, 'headers': headers, 'body': ''}

    try:
        body = json.loads(event.get('body') or '{}')

        # Sanitize and limit input length
        name    = str(body.get('name', '')).strip()[:100]
        email   = str(body.get('email', '')).strip()[:200]
        message = str(body.get('message', '')).strip()[:2000]

        # Validate required fields
        if not name or not email or not message:
            return {
                'statusCode': 400,
                'headers': headers,
                'body': json.dumps({'error': 'All fields are required.'})
            }

        if not is_valid_email(email):
            return {
                'statusCode': 400,
                'headers': headers,
                'body': json.dumps({'error': 'Invalid email address.'})
            }

        # Send email via SES
        ses.send_email(
            Source=os.environ['FROM_EMAIL'],
            Destination={'ToAddresses': [os.environ['TO_EMAIL']]},
            Message={
                'Subject': {
                    'Data': f'portfolio contact: {name}',
                    'Charset': 'UTF-8'
                },
                'Body': {
                    'Text': {
                        'Data': (
                            f'Name:    {name}\n'
                            f'Email:   {email}\n\n'
                            f'Message:\n{message}'
                        ),
                        'Charset': 'UTF-8'
                    }
                }
            },
            ReplyToAddresses=[email]
        )

        return {
            'statusCode': 200,
            'headers': headers,
            'body': json.dumps({'success': True})
        }

    except Exception as e:
        print(f'Error: {e}')
        return {
            'statusCode': 500,
            'headers': headers,
            'body': json.dumps({'error': 'Something went wrong. Please try again.'})
        }
