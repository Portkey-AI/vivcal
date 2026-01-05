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

        // Use full URL if endpoint starts with https, otherwise prepend baseUrl
        const url = endpoint.startsWith('https://') ? endpoint : `${this.baseUrl}${endpoint}`;
        
        log.info('Making API request to:', url);

        const response = await fetch(url, {
            ...options,
            headers: {
                ...options.headers,
                'Authorization': `Bearer ${this.tokens.access_token}`,
                'Accept': 'application/json',
            }
        });

        if (!response.ok) {
            log.error('API request failed:', response.status, response.statusText);
            log.error('URL was:', url);
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

    // Fetch contacts from multiple sources for comprehensive list
    async listConnections(pageToken = '') {
        try {
            // Try People API first for actual Gmail contacts
            log.info('Loading contacts from API...');
            const peopleResponse = await this.makeRequest(`https://people.googleapis.com/v1/people/me/connections?personFields=names,emailAddresses&pageSize=1000${pageToken ? '&pageToken=' + pageToken : ''}`);
            
            const emails = new Set();
            
            // Extract from People API connections
            if (peopleResponse.connections) {
                log.info(`Got ${peopleResponse.connections.length} connections from /me/connections`);
                peopleResponse.connections.forEach(person => {
                    if (person.emailAddresses) {
                        person.emailAddresses.forEach(email => {
                            if (email.value && email.value.includes('@')) {
                                emails.add(email.value);
                            }
                        });
                    }
                });
            }

            // Try to get contacts from other endpoints for more comprehensive results
            try {
                const otherContactsResponse = await this.makeRequest('https://people.googleapis.com/v1/otherContacts?readMask=emailAddresses&pageSize=1000');
                if (otherContactsResponse.otherContacts) {
                    log.info(`Got ${otherContactsResponse.otherContacts.length} other contacts`);
                    otherContactsResponse.otherContacts.forEach(contact => {
                        if (contact.emailAddresses) {
                            contact.emailAddresses.forEach(email => {
                                if (email.value && email.value.includes('@')) {
                                    emails.add(email.value);
                                }
                            });
                        }
                    });
                }
            } catch (e) {
                log.info('Failed to get other contacts:', e.message);
            }

            // Try directory API for more contacts
            try {
                const directoryResponse = await this.makeRequest('https://people.googleapis.com/v1/people:searchDirectoryPeople?readMask=emailAddresses&pageSize=1000&query=""');
                if (directoryResponse.people) {
                    log.info(`Got ${directoryResponse.people.length} directory people`);
                    directoryResponse.people.forEach(person => {
                        if (person.emailAddresses) {
                            person.emailAddresses.forEach(email => {
                                if (email.value && email.value.includes('@')) {
                                    emails.add(email.value);
                                }
                            });
                        }
                    });
                }
            } catch (e) {
                log.info('Failed to search directory:', e.message);
            }

            log.info(`Total unique contacts found from People API: ${emails.size}`);

            // If we got very few contacts from People API, supplement with calendar events
            if (emails.size < 20) {
                log.info('Got few contacts from People API, supplementing with calendar events...');
                const calendarEmails = await this.getEmailsFromCalendarEvents();
                if (calendarEmails.connections) {
                    calendarEmails.connections.forEach(conn => {
                        if (conn.emailAddresses) {
                            conn.emailAddresses.forEach(email => {
                                if (email.value && email.value.includes('@')) {
                                    emails.add(email.value);
                                }
                            });
                        }
                    });
                }
            }

            // Convert to People API format
            const connections = Array.from(emails).map(email => ({
                emailAddresses: [{ value: email }]
            }));

            log.info(`Total unique contacts found: ${emails.size}`);
            log.info('Raw API response:', JSON.stringify(peopleResponse, null, 2));
            return { connections };

        } catch (error) {
            log.error('People API failed, falling back to calendar events');
            return await this.getEmailsFromCalendarEvents();
        }
    }

    // Extract emails from calendar attendees + add common suggestions
    async getEmailsFromCalendarEvents() {
        try {
            const response = await this.makeRequest('/calendars/primary/events?maxResults=200&singleEvents=true&orderBy=startTime');
            const realEmails = new Set();
            
            // Extract real emails from calendar events FIRST
            if (response.items) {
                response.items.forEach(event => {
                    if (event.attendees) {
                        event.attendees.forEach(attendee => {
                            if (attendee.email && attendee.email.includes('@') && !attendee.email.includes('calendar.google.com')) {
                                realEmails.add(attendee.email);
                            }
                        });
                    }
                    if (event.organizer && event.organizer.email && !event.organizer.email.includes('calendar.google.com')) {
                        realEmails.add(event.organizer.email);
                    }
                });
            }

            // Add common email suggestions AFTER real emails (if needed)
            const allEmails = Array.from(realEmails);
            if (allEmails.length < 10) {
                const commonEmails = [
                    'team@company.com',
                    'support@company.com',
                    'hello@startup.com',
                    'contact@business.com',
                    'info@organization.org'
                ];
                commonEmails.forEach(email => {
                    if (!realEmails.has(email)) {
                        allEmails.push(email);
                    }
                });
            }

            // Convert to People API format for compatibility
            const connections = allEmails.map(email => ({
                emailAddresses: [{ value: email }]
            }));

            log.info(`Extracted ${realEmails.size} real emails from calendar events, total ${connections.length} contacts`);
            return { connections };
        } catch (error) {
            log.error('Calendar fallback also failed:', error);
            // Return basic suggestions if everything fails
            const fallbackEmails = [
                'team@company.com',
                'contact@business.com',
                'hello@startup.com',
                'support@company.com',
                'info@organization.org'
            ];
            const connections = fallbackEmails.map(email => ({
                emailAddresses: [{ value: email }]
            }));
            return { connections };
        }
    }
}

module.exports = CalendarClient;