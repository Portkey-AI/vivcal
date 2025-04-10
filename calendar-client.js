const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const log = require('electron-log');

class CalendarClient {
    constructor(credentials, tokens) {
        this.credentials = credentials;
        this.tokens = tokens;
        this.baseUrl = 'https://www.googleapis.com/calendar/v3';
        this.calendar = {
            events: {
                list: this.listEvents.bind(this),
                watch: this.watchEvents.bind(this)
            },
            channels: {
                stop: this.stopChannel.bind(this)
            }
        };
        this.auth = {
            generateAuthUrl: this.generateAuthUrl.bind(this),
            getToken: this.getToken.bind(this)
        };
    }

    async refreshAccessToken() {
        const { client_id, client_secret } = this.credentials.installed;
        const params = new URLSearchParams({
            client_id,
            client_secret,
            refresh_token: this.tokens.refresh_token,
            grant_type: 'refresh_token'
        });

        const response = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            body: params
        });

        if (!response.ok) {
            throw new Error('Failed to refresh token');
        }

        const data = await response.json();
        this.tokens.access_token = data.access_token;
        this.tokens.expiry_date = Date.now() + (data.expires_in * 1000);
        return this.tokens;
    }

    async makeRequest(endpoint, options = {}) {
        if (Date.now() >= this.tokens.expiry_date) {
            log.info('Token expired, refreshing...');
            await this.refreshAccessToken();
        }

        const response = await fetch(`${this.baseUrl}${endpoint}`, {
            ...options,
            headers: {
                ...options.headers,
                'Authorization': `Bearer ${this.tokens.access_token}`,
                'Accept': 'application/json',
            }
        });

        if (!response.ok) {
            throw new Error(`API request failed: ${response.statusText}`);
        }

        return response.json();
    }

    async listEvents(params = {}) {
        const searchParams = new URLSearchParams({
            calendarId: params.calendarId || 'primary',
            timeMin: params.timeMin || new Date().toISOString(),
            maxResults: params.maxResults || '20',
            singleEvents: params.singleEvents || 'true',
            orderBy: params.orderBy || 'startTime',
        });

        const response = await this.makeRequest(`/calendars/primary/events?${searchParams.toString()}`);
        return { data: response }; // Match googleapis response format
    }

    async watchEvents({ calendarId = 'primary', resource }) {
        const response = await this.makeRequest(`/calendars/${calendarId}/events/watch`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(resource)
        });
        return { data: response }; // Match googleapis response format
    }

    async stopChannel({ requestBody }) {
        return this.makeRequest('/channels/stop', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody)
        });
    }

    generateAuthUrl(options) {
        const { client_id } = this.credentials.installed;
        const params = new URLSearchParams({
            client_id,
            response_type: 'code',
            redirect_uri: options.redirect_uris ? options.redirect_uris[0] : this.credentials.installed.redirect_uris[0],
            scope: Array.isArray(options.scope) ? options.scope.join(' ') : options.scope,
            access_type: options.access_type,
        });

        return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    }

    async getToken(code) {
        const { client_id, client_secret } = this.credentials.installed;
        const params = new URLSearchParams({
            client_id,
            client_secret,
            code,
            grant_type: 'authorization_code',
            redirect_uri: this.credentials.installed.redirect_uris[0],
        });

        const response = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            body: params
        });

        if (!response.ok) {
            throw new Error('Failed to get token');
        }

        const tokens = await response.json();
        this.tokens = {
            ...tokens,
            expiry_date: Date.now() + (tokens.expires_in * 1000)
        };

        return { tokens: this.tokens };
    }

    setCredentials(tokens) {
        this.tokens = tokens;
    }
}

module.exports = CalendarClient;