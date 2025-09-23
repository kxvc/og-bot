# Complete OG Bot Deployment Guide (Discord Bot + REST API)

## 📁 **Project Structure**

Your final project should have these files:

```
og-bot-complete/
├── package.json          # Merged dependencies (bot + API)
├── index.js              # Discord bot code
├── api-server.js         # REST API server
├── ecosystem.config.js   # PM2 configuration
├── .env                  # Environment variables
├── .env.example          # Template for others
├── README.md             # Project documentation
├── logs/                 # Log files directory
└── tests/                # Test files (optional)
```

## 🚀 **Running Options**

### **Option 1: Discord Bot Only**
```bash
npm run bot
```

### **Option 2: REST API Only**
```bash
npm run api
# or
npm start
```

### **Option 3: Both Bot + API Together**
```bash
npm run both
```

### **Option 4: Development Mode (Auto-reload)**
```bash
# Both with auto-reload
npm run dev-both

# Bot only with auto-reload
npm run dev-bot

# API only with auto-reload
npm run dev-api
```

## 📦 **Installation Steps**

### **1. Create Project Directory**
```bash
mkdir og-bot-complete
cd og-bot-complete
```

### **2. Initialize Project**
```bash
npm init -y
# Then replace package.json with the merged version above
```

### **3. Install Dependencies**
```bash
npm install
```

### **4. Create Required Files**
Create all the files from the artifacts above:
- `index.js` (Discord bot code)
- `api-server.js` (REST API server)
- `ecosystem.config.js` (PM2 configuration)
- `.env` (Your environment variables)

### **5. Configure Environment**
Edit `.env` with your actual values:
```env
BOT_TOKEN=your_actual_discord_token
API_DOMAIN=https://api.yourdomain.com
MONGODB_URI=your_mongodb_connection_string
JWT_SECRET=your-secret-key-here
```

## 🌐 **VPS Deployment**

### **Deploy Both Services**
```bash
# Upload all files to VPS
scp -r og-bot-complete/* username@your-vps-ip:/home/ogbot/

# SSH to VPS
ssh username@your-vps-ip

# Navigate to bot directory
cd /home/ogbot

# Install dependencies
npm install

# Create logs directory
mkdir logs

# Test both services
npm run both

# If working, stop and use PM2
# Ctrl+C to stop

# Start with PM2
npm run pm2:start

# Check status
pm2 status

# View logs
pm2 logs

# Enable auto-startup
pm2 startup
pm2 save
```

## 🔧 **PM2 Management Commands**

```bash
# Start both services
npm run pm2:start

# Stop all services
npm run pm2:stop

# Restart all services
npm run pm2:restart

# View logs
npm run pm2:logs

# Monitor processes
npm run pm2:monit

# Individual process control
pm2 restart og-bot-discord
pm2 restart og-bot-api
pm2 stop og-bot-discord
pm2 stop og-bot-api
```

## 🌍 **Domain & Nginx Setup**

### **Nginx Configuration**
```nginx
# /etc/nginx/sites-available/ogbot
server {
    listen 80;
    server_name api.yourdomain.com;

    # API endpoints
    location /api/ {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    # Optional: Serve API documentation
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### **Enable Nginx Site**
```bash
# Enable site
sudo ln -s /etc/nginx/sites-available/ogbot /etc/nginx/sites-enabled/

# Test configuration
sudo nginx -t

# Restart Nginx
sudo systemctl restart nginx
```

### **SSL Certificate (Let's Encrypt)**
```bash
# Install Certbot
sudo apt install certbot python3-certbot-nginx

# Get SSL certificate
sudo certbot --nginx -d api.yourdomain.com

# Test auto-renewal
sudo certbot renew --dry-run
```

## 📊 **Monitoring Both Services**

### **Health Checks**
```bash
# Check Discord bot status
pm2 show og-bot-discord

# Check API status  
pm2 show og-bot-api

# Test API health endpoint
curl https://api.yourdomain.com/api/health

# Check both services
pm2 status
```

### **Log Monitoring**
```bash
# All logs
pm2 logs

# Discord bot logs only
pm2 logs og-bot-discord

# API logs only
pm2 logs og-bot-api

# Follow logs in real-time
pm2 logs --lines 50 -f
```

## 🔥 **Testing the Complete Setup**

### **1. Test Discord Bot**
In your Discord server:
```
!verify TestUser123
!leaderboard
!avatar @someone
```

### **2. Test REST API**
```bash
# Generate API key
curl -X POST https://api.yourdomain.com/api/auth/generate-key \
  -H "Content-Type: application/json" \
  -d '{"guildId":"YOUR_GUILD_ID","name":"Test Key"}'

# Test verification endpoint
curl -X POST https://api.yourdomain.com/api/verification/verify \
  -H "Authorization: Bearer ogbot_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{"robloxUsername":"TestUser","discordId":"123456789"}'

# Test leaderboard
curl -H "Authorization: Bearer ogbot_your_api_key" \
     https://api.yourdomain.com/api/xp/leaderboard
```

## 🛡️ **Security Checklist**

- [ ] Environment variables secured (not in git)
- [ ] JWT secret is strong (32+ characters)
- [ ] MongoDB Atlas IP whitelist configured
- [ ] Nginx configured with proper headers
- [ ] SSL certificate installed and working
- [ ] Rate limiting enabled
- [ ] CORS origins properly configured
- [ ] Bot permissions minimized in Discord
- [ ] PM2 running as non-root user

## 📈 **Performance Optimization**

### **PM2 Cluster Mode (for API)**
```javascript
// In ecosystem.config.js, update API app:
{
  name: 'og-bot-api',
  script: 'api-server.js',
  instances: 'max', // Use all CPU cores
  exec_mode: 'cluster',
  // ... other settings
}
```

### **MongoDB Optimization**
- Enable connection pooling
- Create proper indexes
- Monitor connection usage

### **Nginx Optimization**
```nginx
# Add to server block
gzip on;
gzip_types text/plain application/json application/javascript text/css;

# Enable caching for static content
location ~* \.(jpg|jpeg|png|gif|ico|css|js)$ {
    expires 1y;
    add_header Cache-Control "public, immutable";
}
```

## 📋 **Maintenance Schedule**

### **Daily**
- [ ] Check PM2 status: `pm2 status`
- [ ] Monitor logs: `pm2 logs --lines 20`
- [ ] Check API health: `curl https://api.yourdomain.com/api/health`

### **Weekly**
- [ ] Update system: `sudo apt update && sudo apt upgrade`
- [ ] Check disk space: `df -h`
- [ ] Review error logs for issues
- [ ] Test bot commands in Discord

### **Monthly**
- [ ] Update dependencies: `npm update`
- [ ] Rotate logs: `pm2 flush`
- [ ] Review MongoDB usage
- [ ] Check SSL certificate expiry

## 🆘 **Troubleshooting**

### **Both Services Won't Start**
```bash
# Check environment variables
cat .env

# Check MongoDB connection
node -e "const {MongoClient} = require('mongodb'); new MongoClient(process.env.MONGODB_URI).connect().then(()=>console.log('OK')).catch(console.error);"

# Check port availability
netstat -tulpn | grep :3000
```

### **Discord Bot Issues**
```bash
# Check bot token
pm2 logs og-bot-discord | grep -i token

# Check Discord permissions
pm2 logs og-bot-discord | grep -i permission
```

### **API Issues**
```bash
# Check API logs
pm2 logs og-bot-api

# Test API directly
curl http://localhost:3000/api/health
```

This complete setup gives you both the Discord bot and REST API running together, with proper domain configuration, monitoring, and maintenance procedures!