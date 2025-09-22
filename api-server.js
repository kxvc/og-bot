// api-server.js - REST API Server for OG Bot
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { MongoClient } = require('mongodb');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const app = express();
const PORT = process.env.API_PORT || 3000;

// Global variables
let db;
const mongoClient = new MongoClient(process.env.MONGODB_URI);

// Middleware
app.use(helmet());
app.use(cors({
    origin: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:3000'],
    credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: {
        error: 'Too many requests from this IP, please try again later.'
    }
});
app.use('/api/', limiter);

// Strict rate limiting for verification endpoints
const verifyLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 5, // 5 requests per minute
    message: {
        error: 'Too many verification attempts, please try again later.'
    }
});

// Connect to MongoDB
async function connectMongo() {
    try {
        await mongoClient.connect();
        db = mongoClient.db('og_bot');
        console.log('✅ API: Connected to MongoDB Atlas');
        
        // Create indexes
        await db.collection('users').createIndex({ discordId: 1 });
        await db.collection('api_keys').createIndex({ keyHash: 1 });
        await db.collection('config').createIndex({ guildId: 1, type: 1 });
    } catch (error) {
        console.error('❌ API: MongoDB connection failed:', error);
        process.exit(1);
    }
}

// Utility Classes
class APIUtils {
    static async getConfig(guildId, type = 'general') {
        const config = await db.collection('config').findOne({ guildId, type });
        return config || {};
    }

    static async getRobloxUserInfo(username) {
        try {
            const userResponse = await axios.post('https://users.roblox.com/v1/usernames/users', {
                usernames: [username],
                excludeBannedUsers: true
            });

            if (!userResponse.data.data || userResponse.data.data.length === 0) {
                return null;
            }

            const userId = userResponse.data.data[0].id;
            const detailResponse = await axios.get(`https://users.roblox.com/v1/users/${userId}`);
            
            return {
                id: userId,
                username: detailResponse.data.name,
                displayName: detailResponse.data.displayName
            };
        } catch (error) {
            console.error('Error fetching Roblox user info:', error.message);
            return null;
        }
    }

    static async checkKeywords(displayName, keywords) {
        if (!displayName || !keywords || keywords.length === 0) return [];
        
        const foundKeywords = [];
        for (const keyword of keywords) {
            if (displayName.toLowerCase().includes(keyword.toLowerCase())) {
                foundKeywords.push(keyword);
            }
        }
        return foundKeywords;
    }

    static calculateLevel(xp) {
        return Math.floor(Math.sqrt(xp / 100));
    }

    static formatResponse(success, data = null, message = null, errors = null) {
        return {
            success,
            timestamp: new Date().toISOString(),
            data,
            message,
            errors
        };
    }
}

// Authentication Middleware
async function authenticateAPI(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        
        if (!authHeader) {
            return res.status(401).json(APIUtils.formatResponse(false, null, 'No authorization header provided'));
        }

        const token = authHeader.split(' ')[1];
        if (!token) {
            return res.status(401).json(APIUtils.formatResponse(false, null, 'No token provided'));
        }

        // Check if it's an API key or JWT token
        if (token.startsWith('ogbot_')) {
            // API Key authentication
            const keyHash = await bcrypt.hash(token, 10);
            const apiKey = await db.collection('api_keys').findOne({ 
                keyHash: { $exists: true },
                active: true 
            });
            
            if (!apiKey) {
                return res.status(401).json(APIUtils.formatResponse(false, null, 'Invalid API key'));
            }

            const isValid = await bcrypt.compare(token, apiKey.keyHash);
            if (!isValid) {
                return res.status(401).json(APIUtils.formatResponse(false, null, 'Invalid API key'));
            }

            req.apiKey = apiKey;
            req.guildId = apiKey.guildId;
        } else {
            // JWT token authentication
            const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
            req.user = decoded;
            req.guildId = decoded.guildId;
        }

        next();
    } catch (error) {
        return res.status(401).json(APIUtils.formatResponse(false, null, 'Invalid token'));
    }
}

// API Routes

// Health Check
app.get('/api/health', (req, res) => {
    res.json(APIUtils.formatResponse(true, {
        status: 'healthy',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        version: '1.0.0'
    }));
});

// Authentication Routes
app.post('/api/auth/generate-key', async (req, res) => {
    try {
        const { guildId, name, permissions = [] } = req.body;

        if (!guildId || !name) {
            return res.status(400).json(APIUtils.formatResponse(false, null, 'Guild ID and name are required'));
        }

        // Generate API key
        const apiKey = `ogbot_${Math.random().toString(36).substr(2, 32)}`;
        const keyHash = await bcrypt.hash(apiKey, 10);

        await db.collection('api_keys').insertOne({
            keyHash,
            guildId,
            name,
            permissions,
            active: true,
            createdAt: new Date(),
            lastUsed: null
        });

        res.json(APIUtils.formatResponse(true, {
            apiKey,
            guildId,
            name,
            permissions
        }, 'API key generated successfully'));

    } catch (error) {
        console.error('Error generating API key:', error);
        res.status(500).json(APIUtils.formatResponse(false, null, 'Internal server error'));
    }
});

// Roblox Verification Endpoints
app.post('/api/verification/verify', verifyLimiter, authenticateAPI, async (req, res) => {
    try {
        const { robloxUsername, discordId } = req.body;
        const guildId = req.guildId;

        if (!robloxUsername || !discordId) {
            return res.status(400).json(APIUtils.formatResponse(false, null, 'Roblox username and Discord ID are required'));
        }

        // Get verification config
        const config = await APIUtils.getConfig(guildId, 'verification');
        if (!config.keywords || !config.verifiedRoleId) {
            return res.status(400).json(APIUtils.formatResponse(false, null, 'Verification system not configured'));
        }

        // Get Roblox user info
        const robloxUser = await APIUtils.getRobloxUserInfo(robloxUsername);
        if (!robloxUser) {
            return res.status(404).json(APIUtils.formatResponse(false, null, 'Invalid Roblox username'));
        }

        // Check keywords
        const foundKeywords = await APIUtils.checkKeywords(robloxUser.displayName, config.keywords);
        if (foundKeywords.length === 0) {
            return res.status(403).json(APIUtils.formatResponse(false, {
                robloxUser,
                foundKeywords: []
            }, 'Display name does not contain required keywords'));
        }

        // Store verification data
        const userData = {
            guildId,
            discordId,
            robloxUsername: robloxUser.username,
            displayname: robloxUser.displayName,
            verified: true,
            rolesAssigned: [config.verifiedRoleId],
            verifiedAt: new Date(),
            verifiedVia: 'api'
        };

        await db.collection('users').updateOne(
            { discordId, guildId },
            { $set: userData },
            { upsert: true }
        );

        res.json(APIUtils.formatResponse(true, {
            user: userData,
            foundKeywords,
            rolesAssigned: userData.rolesAssigned
        }, 'User verified successfully'));

    } catch (error) {
        console.error('Verification error:', error);
        res.status(500).json(APIUtils.formatResponse(false, null, 'Internal server error'));
    }
});

app.get('/api/verification/user/:discordId', authenticateAPI, async (req, res) => {
    try {
        const { discordId } = req.params;
        const guildId = req.guildId;

        const user = await db.collection('users').findOne({ discordId, guildId });
        
        if (!user) {
            return res.status(404).json(APIUtils.formatResponse(false, null, 'User not found'));
        }

        res.json(APIUtils.formatResponse(true, user));

    } catch (error) {
        console.error('Error fetching user:', error);
        res.status(500).json(APIUtils.formatResponse(false, null, 'Internal server error'));
    }
});

app.delete('/api/verification/user/:discordId', authenticateAPI, async (req, res) => {
    try {
        const { discordId } = req.params;
        const guildId = req.guildId;

        const result = await db.collection('users').deleteOne({ discordId, guildId });
        
        if (result.deletedCount === 0) {
            return res.status(404).json(APIUtils.formatResponse(false, null, 'User not found'));
        }

        res.json(APIUtils.formatResponse(true, null, 'User verification removed'));

    } catch (error) {
        console.error('Error removing verification:', error);
        res.status(500).json(APIUtils.formatResponse(false, null, 'Internal server error'));
    }
});

// XP and Leveling Endpoints
app.get('/api/xp/leaderboard', authenticateAPI, async (req, res) => {
    try {
        const guildId = req.guildId;
        const limit = Math.min(parseInt(req.query.limit) || 10, 100);
        const offset = parseInt(req.query.offset) || 0;

        const leaderboard = await db.collection('xp')
            .find({ guildId })
            .sort({ xp: -1 })
            .skip(offset)
            .limit(limit)
            .toArray();

        const leaderboardWithLevels = leaderboard.map((user, index) => ({
            ...user,
            level: APIUtils.calculateLevel(user.xp),
            rank: offset + index + 1
        }));

        res.json(APIUtils.formatResponse(true, {
            leaderboard: leaderboardWithLevels,
            pagination: {
                limit,
                offset,
                total: await db.collection('xp').countDocuments({ guildId })
            }
        }));

    } catch (error) {
        console.error('Error fetching leaderboard:', error);
        res.status(500).json(APIUtils.formatResponse(false, null, 'Internal server error'));
    }
});

app.get('/api/xp/user/:userId', authenticateAPI, async (req, res) => {
    try {
        const { userId } = req.params;
        const guildId = req.guildId;

        const userXP = await db.collection('xp').findOne({ userId, guildId });
        
        if (!userXP) {
            return res.status(404).json(APIUtils.formatResponse(false, null, 'User XP data not found'));
        }

        const level = APIUtils.calculateLevel(userXP.xp);
        const rank = await db.collection('xp')
            .countDocuments({ guildId, xp: { $gt: userXP.xp } }) + 1;

        res.json(APIUtils.formatResponse(true, {
            ...userXP,
            level,
            rank
        }));

    } catch (error) {
        console.error('Error fetching user XP:', error);
        res.status(500).json(APIUtils.formatResponse(false, null, 'Internal server error'));
    }
});

app.post('/api/xp/add', authenticateAPI, async (req, res) => {
    try {
        const { userId, amount } = req.body;
        const guildId = req.guildId;

        if (!userId || typeof amount !== 'number') {
            return res.status(400).json(APIUtils.formatResponse(false, null, 'User ID and amount are required'));
        }

        const result = await db.collection('xp').findOneAndUpdate(
            { userId, guildId },
            { 
                $inc: { xp: amount },
                $set: { lastUpdated: new Date() }
            },
            { upsert: true, returnDocument: 'after' }
        );

        const level = APIUtils.calculateLevel(result.value.xp);

        res.json(APIUtils.formatResponse(true, {
            ...result.value,
            level,
            addedXP: amount
        }, `Added ${amount} XP to user`));

    } catch (error) {
        console.error('Error adding XP:', error);
        res.status(500).json(APIUtils.formatResponse(false, null, 'Internal server error'));
    }
});

// Warning System Endpoints
app.post('/api/warnings/add', authenticateAPI, async (req, res) => {
    try {
        const { discordId, moderatorId, reason } = req.body;
        const guildId = req.guildId;

        if (!discordId || !moderatorId || !reason) {
            return res.status(400).json(APIUtils.formatResponse(false, null, 'Discord ID, moderator ID, and reason are required'));
        }

        const warning = {
            guildId,
            discordId,
            moderatorId,
            reason,
            timestamp: new Date()
        };

        await db.collection('warnings').insertOne(warning);

        const totalWarnings = await db.collection('warnings')
            .countDocuments({ guildId, discordId });

        res.json(APIUtils.formatResponse(true, {
            warning,
            totalWarnings
        }, 'Warning added successfully'));

    } catch (error) {
        console.error('Error adding warning:', error);
        res.status(500).json(APIUtils.formatResponse(false, null, 'Internal server error'));
    }
});

app.get('/api/warnings/user/:discordId', authenticateAPI, async (req, res) => {
    try {
        const { discordId } = req.params;
        const guildId = req.guildId;

        const warnings = await db.collection('warnings')
            .find({ guildId, discordId })
            .sort({ timestamp: -1 })
            .toArray();

        res.json(APIUtils.formatResponse(true, {
            warnings,
            totalWarnings: warnings.length
        }));

    } catch (error) {
        console.error('Error fetching warnings:', error);
        res.status(500).json(APIUtils.formatResponse(false, null, 'Internal server error'));
    }
});

// Configuration Endpoints
app.get('/api/config/:type', authenticateAPI, async (req, res) => {
    try {
        const { type } = req.params;
        const guildId = req.guildId;

        const config = await APIUtils.getConfig(guildId, type);
        
        res.json(APIUtils.formatResponse(true, config));

    } catch (error) {
        console.error('Error fetching config:', error);
        res.status(500).json(APIUtils.formatResponse(false, null, 'Internal server error'));
    }
});

app.put('/api/config/:type', authenticateAPI, async (req, res) => {
    try {
        const { type } = req.params;
        const guildId = req.guildId;
        const configData = req.body;

        await db.collection('config').updateOne(
            { guildId, type },
            { 
                $set: { 
                    ...configData, 
                    guildId, 
                    type, 
                    updatedAt: new Date() 
                } 
            },
            { upsert: true }
        );

        res.json(APIUtils.formatResponse(true, null, 'Configuration updated successfully'));

    } catch (error) {
        console.error('Error updating config:', error);
        res.status(500).json(APIUtils.formatResponse(false, null, 'Internal server error'));
    }
});

// Discord User Info Endpoints
app.get('/api/discord/user/:userId/avatar', async (req, res) => {
    try {
        const { userId } = req.params;
        const { size = 512, format = 'png' } = req.query;

        const validFormats = ['png', 'jpg', 'webp', 'gif'];
        if (!validFormats.includes(format)) {
            return res.status(400).json(APIUtils.formatResponse(false, null, 'Invalid format'));
        }

        // This would require Discord bot instance or Discord API calls
        // For now, return the Discord CDN URL format
        const avatarUrl = `https://cdn.discordapp.com/avatars/${userId}/avatar.${format}?size=${size}`;
        
        res.json(APIUtils.formatResponse(true, {
            userId,
            avatarUrl,
            formats: {
                png: `https://cdn.discordapp.com/avatars/${userId}/avatar.png?size=${size}`,
                webp: `https://cdn.discordapp.com/avatars/${userId}/avatar.webp?size=${size}`,
                jpg: `https://cdn.discordapp.com/avatars/${userId}/avatar.jpg?size=${size}`
            }
        }));

    } catch (error) {
        console.error('Error fetching avatar:', error);
        res.status(500).json(APIUtils.formatResponse(false, null, 'Internal server error'));
    }
});

// Statistics Endpoints
app.get('/api/stats/overview', authenticateAPI, async (req, res) => {
    try {
        const guildId = req.guildId;

        const [
            totalUsers,
            verifiedUsers,
            totalWarnings,
            totalXPUsers
        ] = await Promise.all([
            db.collection('users').countDocuments({ guildId }),
            db.collection('users').countDocuments({ guildId, verified: true }),
            db.collection('warnings').countDocuments({ guildId }),
            db.collection('xp').countDocuments({ guildId })
        ]);

        const topXPUser = await db.collection('xp')
            .findOne({ guildId }, { sort: { xp: -1 } });

        res.json(APIUtils.formatResponse(true, {
            totalUsers,
            verifiedUsers,
            totalWarnings,
            totalXPUsers,
            topUser: topXPUser ? {
                userId: topXPUser.userId,
                xp: topXPUser.xp,
                level: APIUtils.calculateLevel(topXPUser.xp)
            } : null
        }));

    } catch (error) {
        console.error('Error fetching stats:', error);
        res.status(500).json(APIUtils.formatResponse(false, null, 'Internal server error'));
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('API Error:', err);
    res.status(500).json(APIUtils.formatResponse(false, null, 'Internal server error'));
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json(APIUtils.formatResponse(false, null, 'Endpoint not found'));
});

// Start server
async function startAPI() {
    await connectMongo();
    
    app.listen(PORT, () => {
        console.log(`🚀 OG Bot API Server running on port ${PORT}`);
        console.log(`📖 API Documentation: http://localhost:${PORT}/api/health`);
    });
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('🔄 Shutting down API server...');
    await mongoClient.close();
    process.exit(0);
});

startAPI().catch(console.error);

module.exports = app;
