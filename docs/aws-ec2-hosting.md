# AWS EC2 Hosting Guide

This is the first production hosting path for the payment bot. Use one EC2 instance so only one Telegram polling process runs.

## AWS resources

- Region: Asia Pacific (Singapore), `ap-southeast-1`
- Compute: EC2 Ubuntu, `t3.micro` or `t3.small`
- Database: existing RDS PostgreSQL
- Process manager: PM2
- Reverse proxy: Nginx

## EC2 security group

Inbound rules:

- SSH, port `22`, source: your IP only
- HTTP, port `80`, source: anywhere
- HTTPS, port `443`, source: anywhere, after SSL is configured

Do not expose app port `3001` publicly when Nginx is enabled.

## RDS security group

After EC2 is created, add an inbound PostgreSQL rule to the RDS security group:

- Type: PostgreSQL
- Port: `5432`
- Source: the EC2 security group

You can remove your personal IP from RDS later after migration and testing are complete.

## Server setup

```bash
sudo apt update
sudo apt install -y git nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

Upload or clone the project into:

```bash
/var/www/ew-payment-bot
```

Then install dependencies:

```bash
cd /var/www/ew-payment-bot
npm ci --omit=dev
```

Create `.env` on the server with production values:

```env
PORT=3001
NODE_ENV=production
DB_CLIENT=postgres
DATABASE_URL=postgres://ewbot:YOUR_PASSWORD@YOUR_RDS_ENDPOINT:5432/ew_payment_bot
PGSSL=true
SESSION_SECRET=change-this
```

Add the rest of the current app secrets, such as Telegram, OpenAI, AWS, and Google credentials settings.

## Start the app

```bash
cd /var/www/ew-payment-bot
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

Run the command printed by `pm2 startup`.

## Nginx config

Create:

```bash
sudo nano /etc/nginx/sites-available/ew-payment-bot
```

Use:

```nginx
server {
    listen 80;
    server_name _;

    client_max_body_size 25m;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable it:

```bash
sudo ln -s /etc/nginx/sites-available/ew-payment-bot /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

## Verify

```bash
pm2 status
pm2 logs ew-payment-bot
curl http://127.0.0.1:3001/health
```

Open the EC2 public IP in a browser.
