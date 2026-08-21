import * as cdk from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

interface PortfolioBudgetStackProps extends cdk.StackProps {
  domainName: string;
}

export class PortfolioBudgetStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PortfolioBudgetStackProps) {
    super(scope, id, props);

    // Alert email retrieved from SSM Parameter Store
    // Stored before deploying via:
    // aws ssm put-parameter --name "/portfolio/alert-email" --value "you@yourdomain.com" --type "String" --profile personal
    const alertEmail = ssm.StringParameter.valueForStringParameter(
      this, '/portfolio/alert-email'
    );

    // Monthly cost budget
    // Alerts when actual spend exceeds $5 in a calendar month
    // Expected monthly costs for this infrastructure:
    //   Route 53 hosted zone: ~$0.50
    //   All other services:   ~$0.00 (within free tier)
    // A $5 alert provides meaningful signal that something
    // unexpected is running outside normal parameters
    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: 'portfolio-monthly-budget',
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: {
          amount: 5,
          unit: 'USD',
        },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 85, // Alert at 85% of $5 budget
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [
            {
              subscriptionType: 'EMAIL',
              address: alertEmail,
            },
          ],
        },
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 100, // Alert at 100% of $5 budget
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [
            {
              subscriptionType: 'EMAIL',
              address: alertEmail,
            },
          ],
        },
        {
          notification: {
            notificationType: 'FORECASTED',
            comparisonOperator: 'GREATER_THAN',
            threshold: 100, // Alert when forecast exceeds $5
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [
            {
              subscriptionType: 'EMAIL',
              address: alertEmail,
            },
          ],
        },
      ],
    });

    new cdk.CfnOutput(this, 'BudgetNote', {
      value: 'Monthly budget alert set at $5. Alerts on actual spend and forecasted spend exceeding threshold.',
      description: 'Portfolio monthly cost budget',
    });
  }
}
