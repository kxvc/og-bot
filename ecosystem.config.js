// ecosystem.config.js - PM2 Configuration for both Bot and API
module.exports = {
  apps: [
    {
      name: 'og-bot-discord',
      script: 'index.js',
      cwd: '/home/ogbot',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        BOT_TOKEN: process.env.BOT_TOKEN,
        MONGODB_URI: process.env.MONGODB_URI,
        PREFIX: process.env.PREFIX || '!'
      },
      error_file: './logs/discord-err.log',
      out_file: './logs/discord-out.log',
      log_file: './logs/discord-combined.log',
      time: true
    },
    {
      name: 'og-bot-api',
      script: 'api-server.js',
      cwd: '/home/ogbot',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        MONGODB_URI: process.env.MONGODB_URI,
        API_PORT: process.env.API_PORT || 3000,
        JWT_SECRET: process.env.JWT_SECRET,
        CORS_ORIGINS: process.env.CORS_ORIGINS,
        API_DOMAIN: process.env.API_DOMAIN
      },
      error_file: './logs/api-err.log',
      out_file: './logs/api-out.log',
      log_file: './logs/api-combined.log',
      time: true
    }
  ]
};
