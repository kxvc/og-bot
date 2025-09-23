const { Client, GatewayIntentBits, Collection, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { MongoClient } = require('mongodb');
const cron = require('node-cron');
const axios = require('axios');
require('dotenv').config();

// Bot initialization
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions
    ]
});

// Global variables
const PREFIX = process.env.PREFIX || '!';
let db;
const mongoClient = new MongoClient(process.env.MONGODB_URI);

// Connect to MongoDB
async function connectMongo() {
    try {
        await mongoClient.connect();
        db = mongoClient.db('og_bot');
        console.log('✅ Connected to MongoDB Atlas');
        
        // Create indexes for better performance
        await db.collection('users').createIndex({ discordId: 1 });
        await db.collection('config').createIndex({ guildId: 1, type: 1 });
        await db.collection('warnings').createIndex({ discordId: 1 });
        await db.collection('xp').createIndex({ guildId: 1, userId: 1 });
    } catch (error) {
        console.error('❌ MongoDB connection failed:', error);
        process.exit(1);
    }
}

// Utility functions
class Utils {
    static async getConfig(guildId, type = 'general') {
        const config = await db.collection('config').findOne({ guildId, type });
        return config || {};
    }

    static async updateConfig(guildId, type, data) {
        await db.collection('config').updateOne(
            { guildId, type },
            { $set: { ...data, updatedAt: new Date() } },
            { upsert: true }
        );
    }

    static async getRobloxUserInfo(username) {
        try {
            // Get user ID from username
            const userResponse = await axios.post('https://users.roblox.com/v1/usernames/users', {
                usernames: [username],
                excludeBannedUsers: true
            });

            if (!userResponse.data.data || userResponse.data.data.length === 0) {
                return null;
            }

            const userId = userResponse.data.data[0].id;
            
            // Get user details including display name
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

    static async addXP(guildId, userId, amount) {
        const result = await db.collection('xp').findOneAndUpdate(
            { guildId, userId },
            { 
                $inc: { xp: amount },
                $set: { lastMessage: new Date() }
            },
            { upsert: true, returnDocument: 'after' }
        );
        
        return result.value;
    }

    static calculateLevel(xp) {
        return Math.floor(Math.sqrt(xp / 100));
    }

    static createEmbed(config) {
        const embed = new EmbedBuilder()
            .setTitle(config.title || 'OG Bot')
            .setDescription(config.description || 'No description provided')
            .setColor(config.hexColor || '#00ff00');

        if (config.gifUrl || config.mediaUrl) {
            embed.setImage(config.gifUrl || config.mediaUrl);
        }

        return embed;
    }
}

// Roblox Verification System
class VerificationSystem {
    static async verifyUser(message, username, targetMember = null) {
        try {
            const member = targetMember || message.member;
            const guildId = message.guild.id;
            const config = await Utils.getConfig(guildId, 'verification');

            if (!config.keywords || !config.verifiedRoleId) {
                return message.reply('❌ Verification system not configured. Please contact an administrator.');
            }

            // Get Roblox user info
            const robloxUser = await Utils.getRobloxUserInfo(username);
            if (!robloxUser) {
                return message.reply('❌ Invalid Roblox username. Please check the spelling and try again.');
            }

            // Check for keywords in display name
            const foundKeywords = await Utils.checkKeywords(robloxUser.displayName, config.keywords);
            
            if (foundKeywords.length === 0) {
                return message.reply(`❌ Your Roblox display name "${robloxUser.displayName}" does not contain any required keywords.`);
            }

            // Get verified role
            const verifiedRole = message.guild.roles.cache.get(config.verifiedRoleId);
            if (!verifiedRole) {
                return message.reply('❌ Verified role not found. Please contact an administrator.');
            }

            // Add verified role
            await member.roles.add(verifiedRole);

            // Update nickname
            const nickname = config.nicknameFormat ? config.nicknameFormat.replace('{displayname}', robloxUser.displayName) : robloxUser.displayName;
            try {
                await member.setNickname(nickname);
            } catch (error) {
                console.log('Could not update nickname:', error.message);
            }

            // Add additional keyword-based roles
            const rolesAssigned = [config.verifiedRoleId];
            if (config.keywordRoles) {
                for (const keyword of foundKeywords) {
                    const keywordRole = config.keywordRoles.find(r => r.keyword.toLowerCase() === keyword.toLowerCase());
                    if (keywordRole) {
                        const role = message.guild.roles.cache.get(keywordRole.roleId);
                        if (role) {
                            await member.roles.add(role);
                            rolesAssigned.push(keywordRole.roleId);
                        }
                    }
                }
            }

            // Store in database
            await db.collection('users').updateOne(
                { discordId: member.id },
                {
                    $set: {
                        guildId,
                        robloxUsername: robloxUser.username,
                        displayname: robloxUser.displayName,
                        verified: true,
                        rolesAssigned,
                        verifiedAt: new Date()
                    }
                },
                { upsert: true }
            );

            message.reply(`✅ Successfully verified as **${robloxUser.displayName}**! Found keywords: ${foundKeywords.join(', ')}`);

        } catch (error) {
            console.error('Verification error:', error);
            message.reply('❌ An error occurred during verification. Please try again later.');
        }
    }

    static async dailyVerificationCheck() {
        try {
            console.log('🔄 Starting daily verification check...');
            const users = await db.collection('users').find({ verified: true }).toArray();
            
            for (const user of users) {
                try {
                    const guild = client.guilds.cache.get(user.guildId);
                    if (!guild) continue;

                    const member = guild.members.cache.get(user.discordId);
                    if (!member) continue;

                    const config = await Utils.getConfig(user.guildId, 'verification');
                    if (!config.keywords) continue;

                    // Re-check Roblox user
                    const robloxUser = await Utils.getRobloxUserInfo(user.robloxUsername);
                    if (!robloxUser) continue;

                    const foundKeywords = await Utils.checkKeywords(robloxUser.displayName, config.keywords);
                    
                    // Update display name if changed
                    if (robloxUser.displayName !== user.displayname) {
                        await db.collection('users').updateOne(
                            { discordId: user.discordId },
                            { $set: { displayname: robloxUser.displayName } }
                        );

                        // Update nickname
                        const nickname = config.nicknameFormat ? 
                            config.nicknameFormat.replace('{displayname}', robloxUser.displayName) : 
                            robloxUser.displayName;
                        
                        try {
                            await member.setNickname(nickname);
                        } catch (error) {
                            console.log('Could not update nickname for', user.discordId);
                        }
                    }

                    // Check if they still have required keywords
                    if (foundKeywords.length === 0 && config.removeRoleOnFail) {
                        const verifiedRole = guild.roles.cache.get(config.verifiedRoleId);
                        if (verifiedRole && member.roles.cache.has(config.verifiedRoleId)) {
                            await member.roles.remove(verifiedRole);
                            console.log(`Removed verified role from ${member.displayName} - no longer has keywords`);
                        }
                    }

                } catch (error) {
                    console.error('Error checking user', user.discordId, ':', error.message);
                }
            }
            
            console.log('✅ Daily verification check completed');
        } catch (error) {
            console.error('Daily verification check failed:', error);
        }
    }
}

// XP and Leveling System
class XPSystem {
    static async handleMessage(message) {
        if (message.author.bot || !message.guild) return;

        const config = await Utils.getConfig(message.guild.id, 'leveling');
        const xpPerMessage = config.xpPerMessage || 1;

        const userXP = await Utils.addXP(message.guild.id, message.author.id, xpPerMessage);
        const newLevel = Utils.calculateLevel(userXP.xp);
        const oldLevel = Utils.calculateLevel(userXP.xp - xpPerMessage);

        if (newLevel > oldLevel) {
            // Level up!
            message.channel.send(`🎉 ${message.author} leveled up to level **${newLevel}**!`);

            // Check for level roles
            if (config.levelRoles) {
                const levelRole = config.levelRoles.find(r => r.level === newLevel);
                if (levelRole) {
                    const role = message.guild.roles.cache.get(levelRole.roleId);
                    if (role) {
                        await message.member.roles.add(role);
                        message.channel.send(`🏆 ${message.author} earned the **${role.name}** role!`);
                    }
                }
            }
        }
    }

    static async getLeaderboard(guildId, limit = 10) {
        return await db.collection('xp')
            .find({ guildId })
            .sort({ xp: -1 })
            .limit(limit)
            .toArray();
    }
}

// Channel Permission System
class ChannelPermissions {
    static async setChannelType(guildId, channelId, type) {
        await Utils.updateConfig(guildId, 'channelPermissions', {
            [`${channelId}`]: type
        });
    }

    static async getChannelType(guildId, channelId) {
        const config = await Utils.getConfig(guildId, 'channelPermissions');
        return config[channelId] || 'normal';
    }

    static async checkMessage(message) {
        const channelType = await this.getChannelType(message.guild.id, message.channel.id);
        
        switch (channelType) {
            case 'commandOnly':
                if (!message.content.startsWith(PREFIX) && !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
                    await message.delete();
                    return false;
                }
                break;
                
            case 'mediaOnly':
                if (!message.attachments.size && !this.hasMediaUrl(message.content) && !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
                    await message.delete();
                    return false;
                }
                break;
                
            case 'chatOnly':
                if (message.attachments.size || this.hasMediaUrl(message.content)) {
                    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
                        await message.delete();
                        return false;
                    }
                }
                break;
                
            case 'verifyChannel':
                if (!message.content.startsWith(PREFIX + 'verify') && !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
                    await message.delete();
                    return false;
                }
                break;
        }
        
        return true;
    }

    static hasMediaUrl(content) {
        const mediaRegex = /https?:\/\/.*\.(jpg|jpeg|png|gif|webp|mp4|mov|avi)/i;
        return mediaRegex.test(content);
    }
}

// Warning System
class WarningSystem {
    static async addWarning(guildId, userId, moderatorId, reason) {
        const warning = {
            guildId,
            discordId: userId,
            moderatorId,
            reason,
            timestamp: new Date()
        };

        await db.collection('warnings').insertOne(warning);

        const warnings = await this.getWarnings(guildId, userId);
        return warnings.length;
    }

    static async getWarnings(guildId, userId) {
        return await db.collection('warnings')
            .find({ guildId, discordId: userId })
            .sort({ timestamp: -1 })
            .toArray();
    }

    static async executeWarningAction(guild, member, warningCount, config) {
        const action = config.warningAction || 'kick';
        const maxWarnings = config.maxWarnings || 3;

        if (warningCount >= maxWarnings) {
            try {
                switch (action.toLowerCase()) {
                    case 'kick':
                        await member.kick(`Reached ${maxWarnings} warnings`);
                        break;
                    case 'ban':
                        await member.ban({ reason: `Reached ${maxWarnings} warnings` });
                        break;
                    case 'mute':
                        // Assuming you have a mute role configured
                        const muteRole = guild.roles.cache.find(role => role.name.toLowerCase() === 'muted');
                        if (muteRole) {
                            await member.roles.add(muteRole);
                        }
                        break;
                }
                return true;
            } catch (error) {
                console.error('Error executing warning action:', error);
                return false;
            }
        }
        return false;
    }
}

// Event handlers
client.on('ready', async () => {
    console.log(`🚀 ${client.user.tag} is online!`);
    
    // Set up daily verification check
    const checkTime = '00:00'; // Default midnight
    cron.schedule(`0 0 * * *`, () => {
        VerificationSystem.dailyVerificationCheck();
    });
});

client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    // Check channel permissions
    const permissionCheck = await ChannelPermissions.checkMessage(message);
    if (!permissionCheck) return;

    // Handle XP system
    await XPSystem.handleMessage(message);

    // Handle commands
    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const commandName = args.shift().toLowerCase();

    try {
        switch (commandName) {
            case 'verify':
                await handleVerifyCommand(message, args);
                break;
            case 'warn':
                await handleWarnCommand(message, args);
                break;
            case 'leaderboard':
                await handleLeaderboardCommand(message);
                break;
            case 'avatar':
                await handleAvatarCommand(message, args);
                break;
            case 'pinmessage':
                await handlePinMessageCommand(message, args);
                break;
            case 'setchannel':
                await handleSetChannelCommand(message, args);
                break;
            case 'sendembed':
                await handleSendEmbedCommand(message, args);
                break;
            case 'config':
                await handleConfigCommand(message, args);
                break;
        }
    } catch (error) {
        console.error(`Command error (${commandName}):`, error);
        message.reply('❌ An error occurred while executing this command.');
    }
});

// Welcome/Goodbye messages
client.on('guildMemberAdd', async (member) => {
    const config = await Utils.getConfig(member.guild.id, 'welcome');
    if (!config.channelId) return;

    const channel = member.guild.channels.cache.get(config.channelId);
    if (!channel) return;

    const embed = Utils.createEmbed({
        title: config.title?.replace('{user}', member.displayName) || `Welcome ${member.displayName}!`,
        description: config.description?.replace('{user}', `<@${member.id}>`) || `Welcome to the server, <@${member.id}>!`,
        hexColor: config.hexColor || '#00ff00',
        gifUrl: config.gifUrl,
        mediaUrl: config.mediaUrl
    });

    channel.send({ embeds: [embed] });
});

client.on('guildMemberRemove', async (member) => {
    const config = await Utils.getConfig(member.guild.id, 'goodbye');
    if (!config.channelId) return;

    const channel = member.guild.channels.cache.get(config.channelId);
    if (!channel) return;

    const embed = Utils.createEmbed({
        title: config.title?.replace('{user}', member.displayName) || `Goodbye ${member.displayName}`,
        description: config.description?.replace('{user}', member.displayName) || `${member.displayName} has left the server.`,
        hexColor: config.hexColor || '#ff0000',
        gifUrl: config.gifUrl,
        mediaUrl: config.mediaUrl
    });

    channel.send({ embeds: [embed] });
});

// Command handlers
async function handleVerifyCommand(message, args) {
    if (args.length === 0) {
        return message.reply('❌ Usage: `!verify <roblox_username>` or `!verify <roblox_username> @member`');
    }

    const username = args[0];
    let targetMember = null;

    // Check if admin is verifying someone else
    if (args.length > 1 && message.member.permissions.has(PermissionFlagsBits.Administrator)) {
        
