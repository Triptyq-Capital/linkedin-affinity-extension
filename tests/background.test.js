/**
 * Tests for background.js
 */

// Import the module (requires module.exports to be added to background.js)
const {
  formatConversationNote,
  filterNewMessages,
  getApiKey,
  affinityRequest,
  searchPerson,
  createPerson,
  addNote,
  getNotesForPerson,
  checkDuplicateAndGetExistingMessages,
  findPersonFields,
  populatePersonFields,
  findDropdownOption,
  resetCaches,
  getDashboardData,
  getDashboardDataFresh,
  refreshDashboardCache
} = require('../Extension/background.js');

describe('formatConversationNote', () => {
  test('formats basic conversation with full sender names', () => {
    const data = {
      sender: {
        name: 'John Doe'
      },
      messages: [
        { sender: 'John Doe', content: 'Hello!', timestampDisplay: '10:30 AM', date: '2024-01-15', isIncoming: true },
        { sender: 'Me', content: 'Hi there!', timestampDisplay: '10:35 AM', date: '2024-01-15', isIncoming: false }
      ],
      conversationUrl: 'https://linkedin.com/messaging/thread/123',
      capturedAt: '2024-01-15T15:30:00.000Z'
    };

    const note = formatConversationNote(data);

    // Format: **Name** (YY/MM/DD time):
    expect(note).toContain('https://linkedin.com/messaging/thread/123');
    expect(note).toContain('2024-01-15');
    expect(note).toContain('**John Doe** (24/01/15 10:30 AM):');
    expect(note).toContain('Hello!');
    expect(note).toContain('**Me** (24/01/15 10:35 AM):');
    expect(note).toContain('Hi there!');
  });

  test('handles missing sender headline', () => {
    const data = {
      sender: { name: 'Jane Smith' },
      messages: [],
      conversationUrl: 'https://linkedin.com/messaging/thread/456',
      capturedAt: '2024-01-15T15:30:00.000Z'
    };

    const note = formatConversationNote(data);

    // New format: link is the first line
    expect(note).toContain('https://linkedin.com/messaging/thread/456');
  });

  test('handles missing messages', () => {
    const data = {
      sender: { name: 'Test User' },
      messages: null,
      conversationUrl: 'https://linkedin.com/messaging/thread/789',
      capturedAt: '2024-01-15T15:30:00.000Z'
    };

    const note = formatConversationNote(data);

    // Note should still be created with link
    expect(note).toContain('https://linkedin.com/messaging/thread/789');
  });

  test('handles empty messages array', () => {
    const data = {
      sender: { name: 'Test User' },
      messages: [],
      conversationUrl: 'https://linkedin.com/messaging/thread/789',
      capturedAt: '2024-01-15T15:30:00.000Z'
    };

    const note = formatConversationNote(data);

    // Note should still be created with link
    expect(note).toContain('https://linkedin.com/messaging/thread/789');
  });

  test('handles message without timestamp', () => {
    const data = {
      sender: { name: 'Test User' },
      messages: [{ sender: 'Test User', content: 'No timestamp here', isIncoming: true }],
      conversationUrl: 'https://linkedin.com/messaging/thread/789',
      capturedAt: '2024-01-15T15:30:00.000Z'
    };

    const note = formatConversationNote(data);

    // Format: **Name** (date):
    expect(note).toContain('**Test User**');
    expect(note).toContain('No timestamp here');
  });

  test('uses sender name fallback when message sender is missing', () => {
    const data = {
      sender: { name: 'Test User' },
      messages: [
        { content: 'Incoming message', isIncoming: true },
        { content: 'Outgoing message', isIncoming: false }
      ],
      conversationUrl: 'https://linkedin.com/messaging/thread/789',
      capturedAt: '2024-01-15T15:30:00.000Z'
    };

    const note = formatConversationNote(data);

    expect(note).toContain('**Test User**'); // Uses sender name for incoming
    expect(note).toContain('**You**'); // Uses "You" for outgoing
  });

  test('includes quick note when provided', () => {
    const data = {
      sender: { name: 'John Doe' },
      messages: [],
      conversationUrl: 'https://linkedin.com/messaging/thread/123',
      capturedAt: '2024-01-15T15:30:00.000Z',
      quickNote: 'Met at Web Summit 2024, interested in Series A'
    };

    const note = formatConversationNote(data);

    // New format: quickNote as blockquote
    expect(note).toContain('> Met at Web Summit 2024, interested in Series A');
  });

  test('does not include note section when quickNote is empty', () => {
    const data = {
      sender: { name: 'Jane Smith' },
      messages: [],
      conversationUrl: 'https://linkedin.com/messaging/thread/456',
      capturedAt: '2024-01-15T15:30:00.000Z',
      quickNote: ''
    };

    const note = formatConversationNote(data);

    // No blockquote when quickNote is empty
    expect(note).not.toContain('> ');
  });

  test('does not include note section when quickNote is undefined', () => {
    const data = {
      sender: { name: 'Jane Smith' },
      messages: [],
      conversationUrl: 'https://linkedin.com/messaging/thread/456',
      capturedAt: '2024-01-15T15:30:00.000Z'
    };

    const note = formatConversationNote(data);

    // No blockquote when quickNote is undefined
    expect(note).not.toContain('> ');
  });

  test('includes tags when provided', () => {
    const data = {
      sender: { name: 'John Doe' },
      messages: [],
      conversationUrl: 'https://linkedin.com/messaging/thread/123',
      capturedAt: '2024-01-15T15:30:00.000Z',
      tags: ['Founder', 'Series A']
    };

    const note = formatConversationNote(data);

    // New minimal format: tags are space-separated inline
    expect(note).toContain('Founder · Series A');
  });

  test('formats multiline messages correctly', () => {
    const data = {
      sender: { name: 'John Doe' },
      messages: [
        { sender: 'John Doe', content: 'Line 1\nLine 2\nLine 3', isIncoming: true }
      ],
      conversationUrl: 'https://linkedin.com/messaging/thread/123',
      capturedAt: '2024-01-15T15:30:00.000Z'
    };

    const note = formatConversationNote(data);

    // New minimal format: no blockquotes, just content
    expect(note).toContain('Line 1\nLine 2\nLine 3');
  });
});

describe('filterNewMessages', () => {
  test('returns all messages when no existing messages', () => {
    const messages = [
      { content: 'Hello' },
      { content: 'World' }
    ];
    const existingMessageContents = new Set();

    const result = filterNewMessages(messages, existingMessageContents);

    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('Hello');
    expect(result[1].content).toBe('World');
  });

  test('returns all messages when existingMessageContents is null', () => {
    const messages = [
      { content: 'Hello' },
      { content: 'World' }
    ];

    const result = filterNewMessages(messages, null);

    expect(result).toHaveLength(2);
  });

  test('returns all messages when existingMessageContents is undefined', () => {
    const messages = [
      { content: 'Hello' },
      { content: 'World' }
    ];

    const result = filterNewMessages(messages, undefined);

    expect(result).toHaveLength(2);
  });

  test('filters out existing messages', () => {
    const messages = [
      { content: 'Hello' },
      { content: 'New message' },
      { content: 'World' }
    ];
    const existingMessageContents = new Set(['Hello', 'World']);

    const result = filterNewMessages(messages, existingMessageContents);

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('New message');
  });

  test('handles messages with whitespace', () => {
    const messages = [
      { content: '  Hello  ' },
      { content: 'World' }
    ];
    const existingMessageContents = new Set(['Hello']);

    const result = filterNewMessages(messages, existingMessageContents);

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('World');
  });

  test('filters out messages with empty content when checking against existing', () => {
    const messages = [
      { content: '' },
      { content: '   ' },
      { content: 'Valid message' }
    ];
    // Need at least one existing message for the filter logic to run
    const existingMessageContents = new Set(['Some old message']);

    const result = filterNewMessages(messages, existingMessageContents);

    // Empty and whitespace-only content should be filtered out by the content check
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('Valid message');
  });

  test('handles messages with null content when checking against existing', () => {
    const messages = [
      { content: null },
      { content: 'Valid message' }
    ];
    // Need at least one existing message for the filter logic to run
    const existingMessageContents = new Set(['Some old message']);

    const result = filterNewMessages(messages, existingMessageContents);

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('Valid message');
  });

  test('matches messages with escaped apostrophes (French text)', () => {
    // This is the exact case from the bug report:
    // Stored in Affinity: "Salut Bert, enchanté de t\\'avoir rencontré"
    // Incoming from LinkedIn: "Salut Bert, enchanté de t'avoir rencontré"
    const messages = [
      { content: "Salut Bert, enchanté de t'avoir rencontré en personne" }
    ];
    const existingMessageContents = new Set(["Salut Bert, enchanté de t\\'avoir rencontré en personne"]);

    const result = filterNewMessages(messages, existingMessageContents);

    expect(result).toHaveLength(0); // Should detect as duplicate
  });

  test('matches messages with double-escaped quotes', () => {
    const messages = [
      { content: 'He said "hello" to me' }
    ];
    const existingMessageContents = new Set(['He said \\"hello\\" to me']);

    const result = filterNewMessages(messages, existingMessageContents);

    expect(result).toHaveLength(0); // Should detect as duplicate
  });

  test('matches messages with curly quotes vs straight quotes', () => {
    const messages = [
      { content: "It's a 'test' message" }
    ];
    const existingMessageContents = new Set(["It's a 'test' message"]); // curly quotes

    const result = filterNewMessages(messages, existingMessageContents);

    expect(result).toHaveLength(0); // Should detect as duplicate
  });
});

describe('normalizeMessageContent', () => {
  const { normalizeMessageContent } = require('../Extension/background.js');

  test('removes escaped apostrophes', () => {
    expect(normalizeMessageContent("t\\'avoir")).toBe("t'avoir");
  });

  test('removes escaped double quotes', () => {
    expect(normalizeMessageContent('said \\"hello\\"')).toBe('said "hello"');
  });

  test('handles double-escaped backslashes', () => {
    expect(normalizeMessageContent("path\\\\to\\\\file")).toBe("path\\to\\file");
  });

  test('normalizes multiple spaces to single space', () => {
    expect(normalizeMessageContent("hello   world")).toBe("hello world");
  });

  test('converts curly single quotes to straight quotes', () => {
    expect(normalizeMessageContent("it's")).toBe("it's");
  });

  test('converts curly double quotes to straight quotes', () => {
    expect(normalizeMessageContent('"quoted"')).toBe('"quoted"');
  });

  test('handles empty string', () => {
    expect(normalizeMessageContent('')).toBe('');
  });

  test('handles null/undefined', () => {
    expect(normalizeMessageContent(null)).toBe('');
    expect(normalizeMessageContent(undefined)).toBe('');
  });

  test('trims whitespace', () => {
    expect(normalizeMessageContent('  hello world  ')).toBe('hello world');
  });
});

describe('parseMessageDay', () => {
  const { parseMessageDay } = require('../Extension/background.js');

  test('parses ISO date string', () => {
    expect(parseMessageDay('2024-01-15T10:30:00.000Z')).toBe('2024-01-15');
  });

  test('parses date with time', () => {
    expect(parseMessageDay('2024-01-15 10:30 AM')).toBe('2024-01-15');
  });

  test('parses month day format with year', () => {
    expect(parseMessageDay('Jan 15, 2024 10:30 AM')).toBe('2024-01-15');
  });

  test('parses month day format without year (assumes current year)', () => {
    const currentYear = new Date().getFullYear();
    const result = parseMessageDay('Jan 15, 10:30 AM');
    expect(result).toBe(`${currentYear}-01-15`);
  });

  test('returns null for empty/null timestamp', () => {
    expect(parseMessageDay('')).toBe(null);
    expect(parseMessageDay(null)).toBe(null);
    expect(parseMessageDay(undefined)).toBe(null);
  });
});

describe('groupMessagesByDay', () => {
  const { groupMessagesByDay } = require('../Extension/background.js');

  test('groups messages by day', () => {
    const messages = [
      { content: 'Hello', timestamp: '2024-01-15 10:30 AM' },
      { content: 'Hi', timestamp: '2024-01-15 11:30 AM' },
      { content: 'How are you?', timestamp: '2024-01-16 09:00 AM' }
    ];

    const result = groupMessagesByDay(messages);

    expect(result.size).toBe(2);
    expect(result.get('2024-01-15').length).toBe(2);
    expect(result.get('2024-01-16').length).toBe(1);
  });

  test('sorts days oldest first', () => {
    const messages = [
      { content: 'Later', timestamp: '2024-01-20 10:00 AM' },
      { content: 'First', timestamp: '2024-01-10 10:00 AM' },
      { content: 'Middle', timestamp: '2024-01-15 10:00 AM' }
    ];

    const result = groupMessagesByDay(messages);
    const days = [...result.keys()];

    expect(days[0]).toBe('2024-01-10');
    expect(days[1]).toBe('2024-01-15');
    expect(days[2]).toBe('2024-01-20');
  });

  test('handles messages without timestamps', () => {
    const messages = [
      { content: 'No timestamp' },
      { content: 'With timestamp', timestamp: '2024-01-15 10:00 AM' }
    ];

    const result = groupMessagesByDay(messages);

    expect(result.size).toBe(2);
    expect(result.has('unknown')).toBe(true);
    expect(result.has('2024-01-15')).toBe(true);
  });

  test('returns empty Map for empty messages', () => {
    expect(groupMessagesByDay([]).size).toBe(0);
    expect(groupMessagesByDay(null).size).toBe(0);
  });

  test('uses pre-parsed date field when available', () => {
    const messages = [
      { content: 'Message 1', date: '2024-01-15', timestampDisplay: '10:30 AM' },
      { content: 'Message 2', date: '2024-01-15', timestampDisplay: '11:00 AM' },
      { content: 'Message 3', date: '2024-01-16', timestampDisplay: '09:00 AM' },
      { content: 'Message 4', date: '2024-02-01', timestampDisplay: '02:00 PM' }
    ];

    const result = groupMessagesByDay(messages);

    // Should create 3 separate day groups
    expect(result.size).toBe(3);
    expect(result.get('2024-01-15').length).toBe(2);
    expect(result.get('2024-01-16').length).toBe(1);
    expect(result.get('2024-02-01').length).toBe(1);
  });

  test('groups month-old conversation correctly', () => {
    // Simulate a real conversation spanning multiple days over a month
    const messages = [
      { content: 'Initial outreach', date: '2024-01-05', timestampDisplay: '3:00 PM' },
      { content: 'Thanks for connecting', date: '2024-01-05', timestampDisplay: '4:30 PM' },
      { content: 'Following up', date: '2024-01-12', timestampDisplay: '10:00 AM' },
      { content: 'Sorry for delay', date: '2024-01-12', timestampDisplay: '2:00 PM' },
      { content: 'No problem', date: '2024-01-12', timestampDisplay: '2:05 PM' },
      { content: 'Quick question', date: '2024-01-20', timestampDisplay: '11:00 AM' },
      { content: 'Here is my answer', date: '2024-01-20', timestampDisplay: '3:00 PM' },
      { content: 'Latest message', date: '2024-02-04', timestampDisplay: '9:00 AM' }
    ];

    const result = groupMessagesByDay(messages);

    // Should create 4 separate day groups
    expect(result.size).toBe(4);
    expect(result.get('2024-01-05').length).toBe(2);
    expect(result.get('2024-01-12').length).toBe(3);
    expect(result.get('2024-01-20').length).toBe(2);
    expect(result.get('2024-02-04').length).toBe(1);

    // Verify order is oldest first
    const days = [...result.keys()];
    expect(days[0]).toBe('2024-01-05');
    expect(days[1]).toBe('2024-01-12');
    expect(days[2]).toBe('2024-01-20');
    expect(days[3]).toBe('2024-02-04');
  });
});

describe('formatDayKeyForDisplay', () => {
  const { formatDayKeyForDisplay } = require('../Extension/background.js');

  test('formats date key for display', () => {
    const result = formatDayKeyForDisplay('2024-01-15');
    expect(result).toContain('Jan');
    expect(result).toContain('15');
    expect(result).toContain('2024');
  });

  test('handles unknown date', () => {
    expect(formatDayKeyForDisplay('unknown')).toBe('Unknown Date');
  });
});

describe('extractMessagesFromNote', () => {
  const { extractMessagesFromNote } = require('../Extension/background.js');

  test('extracts messages from note with new format', () => {
    const noteContent = `https://linkedin.com/messaging/thread/123
2024-01-15 · 123

**John Doe** (24/01/15 10:30 AM):
Hello there!

**You** (24/01/15 10:35 AM):
Hi John!
`;

    const result = extractMessagesFromNote(noteContent);

    expect(result.size).toBe(2);
    expect(result.has('Hello there!')).toBe(true);
    expect(result.has('Hi John!')).toBe(true);
  });

  test('handles multiline messages', () => {
    const noteContent = `### Conversation

**◀︎ John Doe**
> Line 1
> Line 2
> Line 3

---`;

    const result = extractMessagesFromNote(noteContent);

    expect(result.size).toBe(1);
    expect(result.has('Line 1\nLine 2\nLine 3')).toBe(true);
  });

  test('returns empty set for note without conversation section', () => {
    const noteContent = '# Some other note\n\nNo conversation here.';
    const result = extractMessagesFromNote(noteContent);
    expect(result.size).toBe(0);
  });
});

describe('appendMessagesToNote', () => {
  const { appendMessagesToNote } = require('../Extension/background.js');

  test('appends messages to end of note', () => {
    const existingContent = `https://linkedin.com/messaging/thread/123
2024-01-15 · 123

**John** (24/01/15 10:30 AM):
Hello!
`;

    const newMessages = [
      { content: 'Hi back!', isIncoming: false, timestampDisplay: '10:35 AM', date: '2024-01-15' }
    ];

    const result = appendMessagesToNote(existingContent, newMessages, 'John');

    expect(result).toContain('Hello!');
    expect(result).toContain('Hi back!');
    expect(result).toContain('**You**');
    expect(result).toContain('10:35 AM');
  });

  test('returns original content if no new messages', () => {
    const existingContent = 'Some content';
    const result = appendMessagesToNote(existingContent, [], 'John');
    expect(result).toBe('Some content');
  });
});

describe('formatDayConversationNote', () => {
  const { formatDayConversationNote } = require('../Extension/background.js');

  test('formats day-specific note with full sender names', () => {
    const data = {
      sender: { name: 'John Doe' },
      conversationUrl: 'https://linkedin.com/messaging/thread/123',
      tags: ['Founder'],
      quickNote: 'Great call!'
    };
    const dayMessages = [
      { content: 'Hello!', isIncoming: true, timestampDisplay: '10:30 AM', date: '2024-01-15' }
    ];

    const result = formatDayConversationNote(data, '2024-01-15', dayMessages);

    // Format: **Name** (YY/MM/DD time):
    expect(result).toContain('https://linkedin.com/messaging/thread/123');
    expect(result).toContain('2024-01-15');
    expect(result).toContain('123'); // Thread ID
    expect(result).toContain('Founder');
    expect(result).toContain('> Great call!');
    expect(result).toContain('**John Doe** (24/01/15 10:30 AM):');
    expect(result).toContain('Hello!');
  });

  test('omits tags and note when empty', () => {
    const data = {
      sender: { name: 'Jane' },
      conversationUrl: 'https://linkedin.com/messaging/thread/456',
      tags: [],
      quickNote: ''
    };
    const dayMessages = [{ content: 'Hi', isIncoming: true }];

    const result = formatDayConversationNote(data, '2024-01-16', dayMessages);

    // Should not have tags or quickNote sections
    expect(result).not.toContain('Founder');
    expect(result).toContain('Hi');     // But message content is present
  });
});

describe('getApiKey', () => {
  test('returns API key from sync storage', async () => {
    global.browser.storage.sync._setData({ affinityApiKey: 'test-api-key-123' });

    const apiKey = await getApiKey();

    expect(apiKey).toBe('test-api-key-123');
  });

  test('falls back to local storage when sync fails', async () => {
    global.browser.storage.sync.get.mockImplementationOnce(() => {
      throw new Error('Sync not available');
    });
    global.browser.storage.local._setData({ affinityApiKey: 'local-api-key' });

    const apiKey = await getApiKey();

    expect(apiKey).toBe('local-api-key');
  });

  test('returns undefined when no API key is set', async () => {
    const apiKey = await getApiKey();

    expect(apiKey).toBeUndefined();
  });
});

describe('affinityRequest', () => {
  test('throws error when API key not configured', async () => {
    await expect(affinityRequest('/test')).rejects.toThrow(
      'Affinity API key not configured'
    );
  });

  test('makes authenticated request with correct headers', async () => {
    setupApiKey('my-secret-key');
    mockFetchResponse({ data: 'test' });

    await affinityRequest('/test');

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.affinity.co/test',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Authorization': expect.stringContaining('Basic'),
          'Content-Type': 'application/json'
        })
      })
    );
  });

  test('handles POST request with body', async () => {
    setupApiKey('my-secret-key');
    mockFetchResponse({ id: 123 });

    await affinityRequest('/persons', {
      method: 'POST',
      body: JSON.stringify({ first_name: 'John' })
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.affinity.co/persons',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ first_name: 'John' })
      })
    );
  });

  test('throws error on API failure', async () => {
    setupApiKey('my-secret-key');
    global.fetch.mockImplementationOnce(() =>
      Promise.resolve({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized')
      })
    );

    await expect(affinityRequest('/test')).rejects.toThrow(
      'Affinity API error (401): Unauthorized'
    );
  });

  test('returns parsed JSON response', async () => {
    setupApiKey('my-secret-key');
    mockFetchResponse({ persons: [{ id: 1, name: 'John' }] });

    const result = await affinityRequest('/persons');

    expect(result).toEqual({ persons: [{ id: 1, name: 'John' }] });
  });
});

describe('searchPerson', () => {
  beforeEach(() => {
    setupApiKey('test-key');
  });

  test('returns persons array from API response', async () => {
    mockFetchResponse({
      persons: [
        { id: 1, first_name: 'John', last_name: 'Doe' },
        { id: 2, first_name: 'Jane', last_name: 'Doe' }
      ]
    });

    const result = await searchPerson('Doe');

    expect(result).toHaveLength(2);
    expect(result[0].first_name).toBe('John');
  });

  test('returns empty array when no persons in response', async () => {
    mockFetchResponse({});

    const result = await searchPerson('Unknown');

    expect(result).toEqual([]);
  });

  test('returns empty array on error', async () => {
    global.fetch.mockImplementationOnce(() =>
      Promise.reject(new Error('Network error'))
    );

    const result = await searchPerson('Test');

    expect(result).toEqual([]);
  });

  test('encodes search term in URL', async () => {
    mockFetchResponse({ persons: [] });

    await searchPerson('John Doe');

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('term=John%20Doe'),
      expect.anything()
    );
  });
});

describe('createPerson', () => {
  beforeEach(() => {
    setupApiKey('test-key');
  });

  test('creates person with first and last name', async () => {
    mockFetchResponse({ id: 123, first_name: 'John', last_name: 'Doe' });

    const result = await createPerson({
      firstName: 'John',
      lastName: 'Doe'
    });

    expect(result.id).toBe(123);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.affinity.co/persons',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          first_name: 'John',
          last_name: 'Doe',
          emails: []
        })
      })
    );
  });

  test('splits full name when firstName/lastName not provided', async () => {
    mockFetchResponse({ id: 456 });

    await createPerson({ name: 'Jane Marie Smith' });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({
          first_name: 'Jane',
          last_name: 'Marie Smith',
          emails: []
        })
      })
    );
  });

  test('uses Unknown when no name provided', async () => {
    mockFetchResponse({ id: 789 });

    await createPerson({});

    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({
          first_name: 'Unknown',
          last_name: '',
          emails: []
        })
      })
    );
  });
});

describe('addNote', () => {
  beforeEach(() => {
    setupApiKey('test-key');
  });

  test('adds note with person ID and content (includeFooter=false)', async () => {
    mockFetchResponse({ id: 'note-123' });

    const result = await addNote(456, '## Test Note\n\nContent here', false);

    expect(result.id).toBe('note-123');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.affinity.co/notes',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          person_ids: [456],
          content: '## Test Note\n\nContent here'
        })
      })
    );
  });

  test('adds note with syncer footer when includeFooter=true', async () => {
    // First call: getCurrentUser() calls /whoami
    mockFetchResponse({
      grant: {
        first_name: 'Test',
        last_name: 'User'
      }
    });
    // Second call: addNote() creates the note
    mockFetchResponse({ id: 'note-456' });

    const result = await addNote(789, 'Note content', true);

    expect(result.id).toBe('note-456');
    // Verify the note content includes the syncer footer
    const calls = global.fetch.mock.calls;
    const noteCall = calls.find(c => c[0].includes('/notes'));
    expect(noteCall).toBeDefined();
    const body = JSON.parse(noteCall[1].body);
    expect(body.content).toContain('Note content');
    expect(body.content).toContain('_Synced by Test U._');
  });
});

describe('getNotesForPerson', () => {
  beforeEach(() => {
    setupApiKey('test-key');
  });

  test('returns notes array from API response', async () => {
    mockFetchResponse({
      notes: [
        { id: 1, content: 'Note 1' },
        { id: 2, content: 'Note 2' }
      ]
    });

    const result = await getNotesForPerson(123);

    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('Note 1');
  });

  test('returns result directly if no notes property', async () => {
    mockFetchResponse([
      { id: 1, content: 'Direct note' }
    ]);

    const result = await getNotesForPerson(123);

    expect(result).toHaveLength(1);
  });

  test('throws on error (fail closed, not empty array)', async () => {
    // A fetch failure must NOT look like "no notes" — that would let the caller
    // re-post a whole conversation as a duplicate. getNotesForPerson now propagates.
    // reject every retry attempt (MAX_RETRIES=2 -> up to 3 calls), without leaking
    // a persistent mock into later tests
    global.fetch
      .mockImplementationOnce(() => Promise.reject(new Error('API error')))
      .mockImplementationOnce(() => Promise.reject(new Error('API error')))
      .mockImplementationOnce(() => Promise.reject(new Error('API error')));

    await expect(getNotesForPerson(123)).rejects.toThrow();
  });
});

describe('checkDuplicateAndGetExistingMessages', () => {
  beforeEach(() => {
    setupApiKey('test-key');
  });

  test('returns isDuplicate false when no matching notes', async () => {
    mockFetchResponse({ notes: [] });

    const result = await checkDuplicateAndGetExistingMessages(
      'https://linkedin.com/messaging/thread/123',
      456
    );

    expect(result.isDuplicate).toBe(false);
    expect(result.existingMessageContents.size).toBe(0);
  });

  test('returns isDuplicate true when conversation URL found in notes', async () => {
    // Note format must match formatConversationNote output - includes --- separator before messages
    mockFetchResponse({
      notes: [
        {
          id: 1,
          content: '## LinkedIn Conversation\n\n**Source:** https://linkedin.com/messaging/thread/123\n\n---\n\n**John** (Jan 1, 2024):\nHello world\n\n',
          created_at: '2024-01-15T10:00:00.000Z'
        }
      ]
    });

    const result = await checkDuplicateAndGetExistingMessages(
      'https://linkedin.com/messaging/thread/123',
      456
    );

    expect(result.isDuplicate).toBe(true);
    expect(result.sentAt).toBe('2024-01-15T10:00:00.000Z');
    expect(result.existingMessageContents.has('Hello world')).toBe(true);
  });

  test('extracts multiple message contents from note', async () => {
    // Note format must match formatConversationNote output - includes --- separator before messages
    mockFetchResponse({
      notes: [
        {
          id: 1,
          content: '**Source:** https://linkedin.com/messaging/thread/123\n\n---\n\n**John** (Jan 1, 2024):\nFirst message\n\n**Jane** (Jan 1, 2024):\nSecond message\n\n',
          created_at: '2024-01-15T10:00:00.000Z'
        }
      ]
    });

    const result = await checkDuplicateAndGetExistingMessages(
      'https://linkedin.com/messaging/thread/123',
      456
    );

    expect(result.existingMessageContents.size).toBe(2);
    expect(result.existingMessageContents.has('First message')).toBe(true);
    expect(result.existingMessageContents.has('Second message')).toBe(true);
  });

  test('returns verificationFailed on error (fail closed)', async () => {
    // Could not read notes -> must not claim "not a duplicate". Flags the failure
    // so the caller aborts instead of silently re-posting the conversation.
    global.fetch
      .mockImplementationOnce(() => Promise.reject(new Error('API error')))
      .mockImplementationOnce(() => Promise.reject(new Error('API error')))
      .mockImplementationOnce(() => Promise.reject(new Error('API error')));

    const result = await checkDuplicateAndGetExistingMessages(
      'https://linkedin.com/messaging/thread/123',
      456
    );

    expect(result.verificationFailed).toBe(true);
    expect(result.isDuplicate).toBe(false);
    expect(result.existingMessageContents.size).toBe(0);
  });

  test('tracks latest note date across multiple matching notes', async () => {
    mockFetchResponse({
      notes: [
        {
          id: 1,
          content: '**Source:** https://linkedin.com/messaging/thread/123\n\n**A**:\nMsg1',
          created_at: '2024-01-10T10:00:00.000Z'
        },
        {
          id: 2,
          content: '**Source:** https://linkedin.com/messaging/thread/123\n\n**B**:\nMsg2',
          created_at: '2024-01-15T10:00:00.000Z'
        }
      ]
    });

    const result = await checkDuplicateAndGetExistingMessages(
      'https://linkedin.com/messaging/thread/123',
      456
    );

    expect(result.sentAt).toBe('2024-01-15T10:00:00.000Z');
  });
});

describe('findDropdownOption', () => {
  test('finds option by exact name match', () => {
    const field = {
      dropdown_options: [
        { id: 1, text: 'Email' },
        { id: 2, text: 'LinkedIn' },
        { id: 3, text: 'Referral' }
      ]
    };

    expect(findDropdownOption(field, 'LinkedIn')).toBe(2);
  });

  test('finds option case-insensitively', () => {
    const field = {
      dropdown_options: [
        { id: 1, text: 'Email' },
        { id: 2, text: 'LinkedIn' },
        { id: 3, text: 'Referral' }
      ]
    };

    expect(findDropdownOption(field, 'linkedin')).toBe(2);
    expect(findDropdownOption(field, 'LINKEDIN')).toBe(2);
  });

  test('finds option by partial match', () => {
    const field = {
      dropdown_options: [
        { id: 1, text: 'Email Campaign' },
        { id: 2, text: 'LinkedIn Outreach' },
        { id: 3, text: 'Referral' }
      ]
    };

    expect(findDropdownOption(field, 'linkedin')).toBe(2);
  });

  test('returns null when no match', () => {
    const field = {
      dropdown_options: [
        { id: 1, text: 'Email' },
        { id: 2, text: 'Referral' }
      ]
    };

    expect(findDropdownOption(field, 'LinkedIn')).toBeNull();
  });

  test('returns null for null field', () => {
    expect(findDropdownOption(null, 'LinkedIn')).toBeNull();
  });

  test('returns null for field without dropdown_options', () => {
    const field = { id: 1, name: 'Source' };
    expect(findDropdownOption(field, 'LinkedIn')).toBeNull();
  });
});

describe('findPersonFields', () => {
  beforeEach(() => {
    resetCaches();
  });

  test('finds all field types correctly', async () => {
    setupApiKey();
    mockFetchResponse([
      { id: 1, name: 'LinkedIn URL', value_type: 6 },
      { id: 2, name: 'LinkedIn Profile Headline', value_type: 6 },
      { id: 3, name: 'Current Job Title', value_type: 6 },
      { id: 4, name: 'Job Titles', value_type: 6 },
      { id: 5, name: 'Location', value_type: 6 },
      { id: 6, name: 'Industry', value_type: 2, dropdown_options: [{ id: 100, text: 'Technology' }] },
      { id: 7, name: 'Phone Number', value_type: 6 },
      { id: 8, name: 'Source of Introduction', value_type: 2, dropdown_options: [{ id: 200, text: 'LinkedIn' }] },
      { id: 9, name: 'Bio', value_type: 6 }
    ]);

    const fields = await findPersonFields();

    expect(fields.linkedin?.id).toBe(1);
    expect(fields.headline?.id).toBe(2);
    expect(fields.currentJobTitle?.id).toBe(3);
    expect(fields.jobTitles?.id).toBe(4);
    expect(fields.location?.id).toBe(5);
    expect(fields.industry?.id).toBe(6);
    expect(fields.phone?.id).toBe(7);
    expect(fields.sourceOfIntroduction?.id).toBe(8);
    expect(fields.bio?.id).toBe(9);
  });

  test('finds fields with alternative names', async () => {
    setupApiKey();
    mockFetchResponse([
      { id: 1, name: 'LinkedIn', value_type: 6 },
      { id: 2, name: 'Headline', value_type: 6 },
      { id: 3, name: 'Title', value_type: 6 },
      { id: 4, name: 'City', value_type: 6 },
      { id: 5, name: 'Sector', value_type: 6 },
      { id: 6, name: 'Mobile', value_type: 6 }
    ]);

    const fields = await findPersonFields();

    expect(fields.linkedin?.id).toBe(1);
    expect(fields.headline?.id).toBe(2);
    expect(fields.currentJobTitle?.id).toBe(3);
    expect(fields.location?.id).toBe(4);
    expect(fields.industry?.id).toBe(5);
    expect(fields.phone?.id).toBe(6);
  });

  test('caches field definitions', async () => {
    setupApiKey();
    mockFetchResponse([{ id: 1, name: 'LinkedIn URL', value_type: 6 }]);

    await findPersonFields();
    await findPersonFields();

    // Fetch should only be called once (for the first call)
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('handles empty field list', async () => {
    setupApiKey();
    mockFetchResponse([]);

    const fields = await findPersonFields();

    expect(fields.linkedin).toBeUndefined();
    expect(fields._all).toEqual([]);
  });
});

describe('populatePersonFields', () => {
  beforeEach(() => {
    resetCaches();
  });

  test('populates all available text fields', async () => {
    setupApiKey();

    // First call returns field definitions
    mockFetchResponse([
      { id: 1, name: 'LinkedIn URL', value_type: 6 },
      { id: 2, name: 'LinkedIn Profile Headline', value_type: 6 },
      { id: 3, name: 'Current Job Title', value_type: 6 },
      { id: 4, name: 'Job Titles', value_type: 6 },
      { id: 5, name: 'Location', value_type: 6 },
      { id: 6, name: 'Industry', value_type: 6 },
      { id: 7, name: 'Bio', value_type: 6 }
    ]);

    // Subsequent calls return success for field value creation
    for (let i = 0; i < 7; i++) {
      mockFetchResponse({ id: 100 + i });
    }

    const profileData = {
      linkedinUrl: 'https://linkedin.com/in/johndoe',
      headline: 'CEO at TechCorp',
      currentJobTitle: 'Chief Executive Officer',
      allJobTitles: ['CEO', 'CTO', 'Engineer'],
      location: 'San Francisco, CA',
      industry: 'Technology',
      about: 'Passionate about technology'
    };

    const results = await populatePersonFields(123, profileData, true);

    expect(results.length).toBe(7);
    expect(results.map(r => r.field)).toContain('linkedin');
    expect(results.map(r => r.field)).toContain('headline');
    expect(results.map(r => r.field)).toContain('currentJobTitle');
    expect(results.map(r => r.field)).toContain('jobTitles');
    expect(results.map(r => r.field)).toContain('location');
    expect(results.map(r => r.field)).toContain('industry');
    expect(results.map(r => r.field)).toContain('bio');
  });

  test('populates Source of Introduction dropdown for new persons', async () => {
    setupApiKey();

    // Field definitions with Source of Introduction dropdown
    mockFetchResponse([
      { id: 1, name: 'Source of Introduction', value_type: 2, dropdown_options: [
        { id: 100, text: 'Email' },
        { id: 101, text: 'LinkedIn' },
        { id: 102, text: 'Referral' }
      ]}
    ]);

    // Success for field value creation
    mockFetchResponse({ id: 200 });

    const results = await populatePersonFields(123, {}, true);

    expect(results.length).toBe(1);
    expect(results[0].field).toBe('sourceOfIntroduction');

    // Verify the correct dropdown option ID was used
    const calls = global.fetch.mock.calls;
    const fieldValueCall = calls.find(c => c[0].includes('/field-values'));
    expect(fieldValueCall).toBeDefined();
    const body = JSON.parse(fieldValueCall[1].body);
    expect(body.value).toBe(101); // LinkedIn option ID
  });

  test('does not populate Source of Introduction for existing persons', async () => {
    setupApiKey();

    mockFetchResponse([
      { id: 1, name: 'Source of Introduction', value_type: 2, dropdown_options: [
        { id: 101, text: 'LinkedIn' }
      ]}
    ]);

    const results = await populatePersonFields(123, {}, false); // isNewPerson = false

    expect(results.length).toBe(0);
  });

  test('populates industry dropdown field correctly', async () => {
    setupApiKey();

    // Affinity dropdown fields accept text values directly
    mockFetchResponse([
      { id: 1, name: 'Industry', value_type: 2 }
    ]);

    mockFetchResponse({ id: 200 });

    const results = await populatePersonFields(123, { industry: 'Technology' }, false);

    expect(results.length).toBe(1);
    expect(results[0].field).toBe('industry');

    // Verify the text value was set directly (Affinity dropdowns accept any text)
    const calls = global.fetch.mock.calls;
    const fieldValueCall = calls.find(c => c[0].includes('/field-values'));
    const body = JSON.parse(fieldValueCall[1].body);
    expect(body.value).toBe('Technology');
  });

  test('concatenates all job titles', async () => {
    setupApiKey();

    mockFetchResponse([
      { id: 1, name: 'Job Titles', value_type: 6 }
    ]);

    mockFetchResponse({ id: 200 });

    await populatePersonFields(123, {
      allJobTitles: ['CEO', 'CTO', 'Software Engineer']
    }, false);

    const calls = global.fetch.mock.calls;
    const fieldValueCall = calls.find(c => c[0].includes('/field-values'));
    const body = JSON.parse(fieldValueCall[1].body);
    expect(body.value).toBe('CEO, CTO, Software Engineer');
  });

  test('handles missing profile data gracefully', async () => {
    setupApiKey();

    mockFetchResponse([
      { id: 1, name: 'LinkedIn URL', value_type: 6 },
      { id: 2, name: 'Location', value_type: 6 }
    ]);

    // Should not make any field-value calls since no data provided
    const results = await populatePersonFields(123, {}, false);

    expect(results.length).toBe(0);
  });
});

describe('Dashboard Caching', () => {
  // Set up URL-based mocks for all dashboard API endpoints
  function setupDashboardMocks() {
    setupApiKey();
    global.fetch.mockImplementation((url) => {
      let response = {};
      if (url.includes('/list-entries')) {
        response = [{ id: 1 }, { id: 2 }, { id: 3 }];
      } else if (url.includes('/lists')) {
        response = [
          { id: 100, name: 'Pipeline', type: 8 },
          { id: 101, name: 'Contacts', type: 0 }
        ];
      } else if (url.includes('/notes')) {
        response = { notes: [
          { id: 1, content: '**Test** note', created_at: new Date().toISOString() }
        ]};
      } else if (url.includes('/fields')) {
        response = [];
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(response),
        text: () => Promise.resolve(JSON.stringify(response))
      });
    });
  }

  beforeEach(() => {
    resetCaches();
    setupDashboardMocks();
  });

  test('returns cached data without API calls on second call', async () => {
    const result1 = await getDashboardData();
    expect(result1.isStale).toBe(false);
    expect(result1.data).toBeTruthy();
    expect(result1.data.lists.length).toBe(2);

    const fetchCallCount = global.fetch.mock.calls.length;

    const result2 = await getDashboardData();
    expect(result2.isStale).toBe(false);
    expect(result2.data).toEqual(result1.data);

    // No additional API calls should have been made
    expect(global.fetch.mock.calls.length).toBe(fetchCallCount);
  });

  test('returns isStale true after cache TTL expires', async () => {
    const realDateNow = Date.now;
    let currentTime = realDateNow.call(Date);
    Date.now = jest.fn(() => currentTime);

    try {
      const result1 = await getDashboardData();
      expect(result1.isStale).toBe(false);

      // Advance time past 2-minute TTL
      currentTime += 2 * 60 * 1000 + 1;

      const result2 = await getDashboardData();
      expect(result2.isStale).toBe(true);
      expect(result2.data).toBeTruthy();

      // Let the fire-and-forget background refresh complete
      await new Promise(resolve => setTimeout(resolve, 10));
    } finally {
      Date.now = realDateNow;
    }
  });

  test('list counts cache skips getListEntries API calls on second fetch', async () => {
    // First call fetches everything including list entries
    await getDashboardDataFresh();

    const listEntryCalls1 = global.fetch.mock.calls.filter(
      c => c[0].includes('/list-entries')
    );
    expect(listEntryCalls1.length).toBe(2); // One per list

    // Clear call history but keep the same mock implementation
    global.fetch.mockClear();

    // Second call should use cached list counts (within 15-min TTL)
    await getDashboardDataFresh();

    const listEntryCalls2 = global.fetch.mock.calls.filter(
      c => c[0].includes('/list-entries')
    );
    expect(listEntryCalls2.length).toBe(0);
  });

  test('resetCaches clears dashboard caches', async () => {
    // Populate cache
    await getDashboardData();
    const fetchCallCount = global.fetch.mock.calls.length;
    expect(fetchCallCount).toBeGreaterThan(0);

    // Clear all caches
    resetCaches();

    // Next call should make fresh API calls
    await getDashboardData();
    expect(global.fetch.mock.calls.length).toBeGreaterThan(fetchCallCount);
  });
});

describe('Dashboard Performance Benchmark', () => {
  function setupDashboardMocks() {
    setupApiKey();
    global.fetch.mockImplementation((url) => {
      let response = {};
      if (url.includes('/list-entries')) {
        response = Array.from({ length: 50 }, (_, i) => ({ id: i + 1 }));
      } else if (url.includes('/lists')) {
        response = Array.from({ length: 8 }, (_, i) => ({
          id: 100 + i, name: `List ${i + 1}`, type: i % 3 === 0 ? 8 : 0
        }));
      } else if (url.includes('/notes')) {
        response = { notes: Array.from({ length: 20 }, (_, i) => ({
          id: i + 1,
          content: `**Person ${i}** note content with follow up mention`,
          created_at: new Date(Date.now() - i * 3600000).toISOString()
        }))};
      } else if (url.includes('/fields')) {
        response = [];
      }
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve(response),
        text: () => Promise.resolve(JSON.stringify(response))
      });
    });
  }

  beforeEach(() => {
    resetCaches();
    setupDashboardMocks();
  });

  test('benchmark: cached vs fresh dashboard load', async () => {
    // --- Fresh load (no cache) ---
    const freshStart = performance.now();
    const freshResult = await getDashboardData();
    const freshTime = performance.now() - freshStart;
    const freshApiCalls = global.fetch.mock.calls.length;

    expect(freshResult.isStale).toBe(false);
    expect(freshResult.data.lists.length).toBe(8);

    // --- Cached load (within TTL) ---
    const cachedStart = performance.now();
    const cachedResult = await getDashboardData();
    const cachedTime = performance.now() - cachedStart;
    const cachedApiCalls = global.fetch.mock.calls.length - freshApiCalls;

    expect(cachedResult.isStale).toBe(false);
    expect(cachedApiCalls).toBe(0);

    // --- Fresh load with list counts cached (reset dashboard but keep list counts) ---
    // Simulate: dashboard cache expired but list counts still fresh
    const realDateNow = Date.now;
    let currentTime = realDateNow.call(Date);
    Date.now = jest.fn(() => currentTime);

    // Reset only the dashboard data cache by advancing past its TTL
    currentTime += 2 * 60 * 1000 + 1;
    global.fetch.mockClear();
    setupDashboardMocks();

    const partialStart = performance.now();
    // This will return stale, triggering background refresh
    const partialResult = await getDashboardData();
    const partialTime = performance.now() - partialStart;

    // Let the background refresh complete
    await new Promise(resolve => setTimeout(resolve, 20));
    const partialApiCalls = global.fetch.mock.calls.length;

    Date.now = realDateNow;

    // --- Report ---
    const report = [
      '',
      '╔══════════════════════════════════════════════════════╗',
      '║         Dashboard Performance Benchmark             ║',
      '╠══════════════════════════════════════════════════════╣',
      `║ Fresh load (cold cache):                            ║`,
      `║   Time: ${freshTime.toFixed(2).padStart(8)}ms | API calls: ${String(freshApiCalls).padStart(2)}            ║`,
      `║ Cached load (warm cache):                           ║`,
      `║   Time: ${cachedTime.toFixed(2).padStart(8)}ms | API calls: ${String(cachedApiCalls).padStart(2)}            ║`,
      `║ Stale load (list counts cached):                    ║`,
      `║   Time: ${partialTime.toFixed(2).padStart(8)}ms | API calls: ${String(partialApiCalls).padStart(2)}            ║`,
      '╠══════════════════════════════════════════════════════╣',
      `║ Speedup (cached vs fresh): ${(freshTime / Math.max(cachedTime, 0.01)).toFixed(0).padStart(5)}x                    ║`,
      `║ API calls saved (cached):  ${String(freshApiCalls).padStart(5)}                    ║`,
      `║ API calls saved (stale):   ${String(freshApiCalls - partialApiCalls).padStart(5)}                    ║`,
      '╚══════════════════════════════════════════════════════╝',
    ];
    console.log(report.join('\n'));

    // Assertions
    expect(cachedTime).toBeLessThan(freshTime);
    expect(cachedApiCalls).toBe(0);
    // Stale path returns immediately (no API calls in the synchronous return)
    expect(partialResult.isStale).toBe(true);
  });
});
