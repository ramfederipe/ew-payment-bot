# AWS Deployment Guide

This app is currently a Node.js Express service with Socket.IO, Telegram polling/webhook logic, SQLite (`database.db`), local uploads, and Google Sheets credentials.

## Recommended AWS target

Use this path for the least painful production setup:

- Compute: ECS Fargate running this Docker image
- Load balancer: Application Load Balancer with HTTPS
- Database: RDS PostgreSQL
- File storage: S3 for uploaded images/videos
- Secrets: AWS Secrets Manager or SSM Parameter Store
- Logs: CloudWatch Logs
- DNS: Route 53 or keep Cloudflare DNS pointing to the ALB

## Phase 1: Deploy the current app

This gets the app running in AWS, but SQLite and local uploads are not ideal for production scaling.

1. Rotate any exposed API keys before deploying.
2. Create a private ECR repository.
3. Build and push the image:

```bash
aws ecr get-login-password --region ap-southeast-1 | docker login --username AWS --password-stdin <account-id>.dkr.ecr.ap-southeast-1.amazonaws.com
docker build -t ew-payment-bot .
docker tag ew-payment-bot:latest <account-id>.dkr.ecr.ap-southeast-1.amazonaws.com/ew-payment-bot:latest
docker push <account-id>.dkr.ecr.ap-southeast-1.amazonaws.com/ew-payment-bot:latest
```

4. Create an ECS Fargate service using port `3001`.
5. Configure the ALB health check path as `/health`.
6. Add environment variables from `.env.example` through ECS task secrets, not a committed `.env` file.

## Phase 2: Make it production-safe

Before relying on AWS as the main system, migrate these local resources:

- Move `database.db` to RDS PostgreSQL.
- Move `uploads/` to S3.
- Move `credentials/credentials.json` to Secrets Manager.
- Replace the default Express session store with a shared store such as Redis or PostgreSQL.
- Use IAM roles for AWS access instead of long-lived access keys.

## Notes for this repository

- Run locally with `npm start`.
- The container listens on `PORT`, defaulting to `3001`.
- The AWS load balancer can verify the app with `GET /health`.
- The existing Cloudflare tunnel can be retired after DNS points to the AWS load balancer.

## PostgreSQL migration

Set `DATABASE_URL` to your PostgreSQL connection string and run:

```bash
npm run migrate:postgres
```

By default the migration reads `database.db` from the project root. To use a different SQLite file:

```bash
SQLITE_DB_PATH=/path/to/database.db npm run migrate:postgres
```

After migration, keep `DATABASE_URL` and `DB_CLIENT=postgres` in your AWS task environment.
