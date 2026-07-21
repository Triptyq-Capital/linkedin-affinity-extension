// LinkedIn to Affinity - Background Service Worker
// Handles Affinity API communication

// Use browser or chrome API (Safari compatibility)
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

const AFFINITY_API_BASE = 'https://api.affinity.co';

// ============================================================================
// Badge Counter Functions
// ============================================================================

/**
 * Update the extension badge with today's sync count
 */
async function updateBadgeCount() {
  try {
    const today = toLocalDateString(new Date());
    const result = await browserAPI.storage.local.get(['dailySyncCount', 'dailySyncDate']);

    let count = 0;
    if (result.dailySyncDate === today) {
      count = result.dailySyncCount || 0;
    }

    // Update badge
    const badgeText = count > 0 ? String(count) : '';
    if (browserAPI.action) {
      // Manifest V3
      browserAPI.action.setBadgeText({ text: badgeText });
      browserAPI.action.setBadgeBackgroundColor({ color: '#0a66c2' });
    } else if (browserAPI.browserAction) {
      // Manifest V2 / Safari
      browserAPI.browserAction.setBadgeText({ text: badgeText });
      browserAPI.browserAction.setBadgeBackgroundColor({ color: '#0a66c2' });
    }
  } catch (error) {
    console.error('[LinkedIn to Affinity] Error updating badge:', error);
  }
}

/**
 * Increment today's sync count and update badge
 */
async function incrementSyncCount() {
  try {
    const today = toLocalDateString(new Date());
    const result = await browserAPI.storage.local.get(['dailySyncCount', 'dailySyncDate', 'syncCount']);

    let dailyCount = 0;
    if (result.dailySyncDate === today) {
      dailyCount = result.dailySyncCount || 0;
    }
    dailyCount++;

    // Also update total count
    const totalCount = (result.syncCount || 0) + 1;

    await browserAPI.storage.local.set({
      dailySyncCount: dailyCount,
      dailySyncDate: today,
      syncCount: totalCount
    });

    await updateBadgeCount();
    console.log('[LinkedIn to Affinity] Sync count updated - today:', dailyCount, 'total:', totalCount);
  } catch (error) {
    console.error('[LinkedIn to Affinity] Error incrementing sync count:', error);
  }
}

/**
 * Convert a Date to local YYYY-MM-DD string (not UTC)
 * This fixes timezone issues where toISOString() returns next day in UTC
 */
function toLocalDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Get stored API key from extension storage
 */
async function getApiKey() {
  try {
    const result = await browserAPI.storage.sync.get(['affinityApiKey']);
    return result.affinityApiKey;
  } catch (error) {
    // Fallback to local storage if sync not available
    const result = await browserAPI.storage.local.get(['affinityApiKey']);
    return result.affinityApiKey;
  }
}

/**
 * Make authenticated request to Affinity API
 */
const AFFINITY_TIMEOUT_MS = 15000;   // no request may hang forever (MV3 worker would stall)
const AFFINITY_MAX_RETRIES = 2;      // transient 429/5xx/network only

async function affinityRequest(endpoint, options = {}) {
  const apiKey = await getApiKey();

  if (!apiKey) {
    throw new Error('Affinity API key not configured. Click the extension icon to set it up.');
  }

  const url = `${AFFINITY_API_BASE}${endpoint}`;
  let lastErr;

  for (let attempt = 0; attempt <= AFFINITY_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AFFINITY_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          'Authorization': `Basic ${btoa(':' + apiKey)}`,
          'Content-Type': 'application/json',
          ...options.headers
        }
      });
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;   // network failure or AbortError (timeout)
      if (attempt < AFFINITY_MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
        continue;
      }
      throw err;
    }
    clearTimeout(timer);

    // Retry transient rate-limit / server errors with backoff before giving up
    if ((response.status === 429 || response.status >= 500) && attempt < AFFINITY_MAX_RETRIES) {
      lastErr = new Error(`Affinity API error (${response.status})`);
      await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
      continue;
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Affinity API error (${response.status}): ${errorText}`);
    }

    return response.json();
  }

  throw lastErr || new Error('Affinity request failed');
}

/**
 * Search for a person in Affinity by name
 */
async function searchPerson(name) {
  try {
    const result = await affinityRequest(`/persons?term=${encodeURIComponent(name)}`);
    return result.persons || [];
  } catch (error) {
    console.error('[LinkedIn to Affinity] Error searching person:', error);
    return [];
  }
}

/**
 * Search for a person by LinkedIn URL in field values
 */
async function findPersonByLinkedIn(linkedinUrl) {
  if (!linkedinUrl) return null;

  // First search by name, then filter by LinkedIn URL in the results
  // Affinity doesn't have a direct LinkedIn URL search, so we check field values
  // This is a limitation - in production you might want to cache/index this

  return null; // Will rely on name search for now
}

/**
 * Fetch and parse a LinkedIn profile page for detailed information
 */
async function fetchLinkedInProfile(profileUrl) {
  if (!profileUrl) return null;

  try {

    const response = await fetch(profileUrl, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      credentials: 'include' // Include cookies for authenticated request
    });

    if (!response.ok) {
      console.error('[LinkedIn to Affinity] Failed to fetch profile:', response.status);
      return null;
    }

    const html = await response.text();
    return parseLinkedInProfileHtml(html);
  } catch (error) {
    console.error('[LinkedIn to Affinity] Error fetching profile:', error);
    return null;
  }
}

/**
 * Parse LinkedIn profile HTML to extract structured data
 */
function parseLinkedInProfileHtml(html) {
  const profile = {
    name: null,
    firstName: null,
    lastName: null,
    headline: null,
    title: null,
    company: null,
    location: null,
    about: null,
    profileImageUrl: null,
    connectionDegree: null
  };

  try {
    // Create a DOM parser
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Try to extract from JSON-LD structured data (most reliable)
    const jsonLdScript = doc.querySelector('script[type="application/ld+json"]');
    if (jsonLdScript) {
      try {
        const jsonLd = JSON.parse(jsonLdScript.textContent);
        if (jsonLd['@type'] === 'Person') {
          profile.name = jsonLd.name;
          profile.location = jsonLd.address?.addressLocality;
          profile.about = jsonLd.description;
          profile.profileImageUrl = jsonLd.image?.contentUrl || jsonLd.image;

          if (jsonLd.worksFor && jsonLd.worksFor.length > 0) {
            const currentJob = jsonLd.worksFor[0];
            profile.company = currentJob.name;
          }

          if (jsonLd.jobTitle && jsonLd.jobTitle.length > 0) {
            profile.title = jsonLd.jobTitle[0];
          }
        }
      } catch (e) {
        console.log('[LinkedIn to Affinity] Could not parse JSON-LD');
      }
    }

    // Fallback: Extract from meta tags
    if (!profile.name) {
      const titleMeta = doc.querySelector('meta[property="og:title"]');
      if (titleMeta) {
        // Format is usually "Name | LinkedIn" or "Name - Title | LinkedIn"
        const title = titleMeta.getAttribute('content');
        const namePart = title?.split('|')[0]?.split('-')[0]?.trim();
        if (namePart) profile.name = namePart;
      }
    }

    if (!profile.about) {
      const descMeta = doc.querySelector('meta[property="og:description"], meta[name="description"]');
      if (descMeta) {
        profile.about = descMeta.getAttribute('content');
      }
    }

    if (!profile.profileImageUrl) {
      const imageMeta = doc.querySelector('meta[property="og:image"]');
      if (imageMeta) {
        profile.profileImageUrl = imageMeta.getAttribute('content');
      }
    }

    // Fallback: Extract from visible page elements
    // Name from profile header
    if (!profile.name) {
      const nameEl = doc.querySelector(
        '.text-heading-xlarge, ' +
        '.pv-text-details__left-panel h1, ' +
        '[data-anonymize="person-name"]'
      );
      if (nameEl) profile.name = nameEl.textContent?.trim();
    }

    // Headline
    if (!profile.headline) {
      const headlineEl = doc.querySelector(
        '.text-body-medium.break-words, ' +
        '.pv-text-details__left-panel .text-body-medium, ' +
        '[data-anonymize="headline"]'
      );
      if (headlineEl) profile.headline = headlineEl.textContent?.trim();
    }

    // Location
    if (!profile.location) {
      const locationEl = doc.querySelector(
        '.text-body-small.inline.t-black--light.break-words, ' +
        '.pv-text-details__left-panel .text-body-small, ' +
        '[data-anonymize="location"]'
      );
      if (locationEl) profile.location = locationEl.textContent?.trim();
    }

    // Current position - look for Experience section
    if (!profile.title || !profile.company) {
      // Try to find current job in experience section
      const experienceSection = doc.querySelector('#experience, [data-section="experience"]');
      if (experienceSection) {
        const firstJob = experienceSection.querySelector('li, .pvs-entity');
        if (firstJob) {
          const jobTitleEl = firstJob.querySelector('.t-bold span, .mr1.t-bold span');
          const companyEl = firstJob.querySelector('.t-normal span, .t-14.t-normal span');

          if (jobTitleEl && !profile.title) {
            profile.title = jobTitleEl.textContent?.trim();
          }
          if (companyEl && !profile.company) {
            // Company name might include "· Full-time" etc, split it
            const companyText = companyEl.textContent?.trim();
            profile.company = companyText?.split('·')[0]?.trim();
          }
        }
      }
    }

    // Parse title and company from headline if not found elsewhere
    if (profile.headline && (!profile.title || !profile.company)) {
      const headlineParsed = parseHeadlineForProfile(profile.headline);
      if (!profile.title && headlineParsed.title) {
        profile.title = headlineParsed.title;
      }
      if (!profile.company && headlineParsed.company) {
        profile.company = headlineParsed.company;
      }
    }

    // Parse name into first/last
    if (profile.name) {
      const nameParts = profile.name.split(' ');
      profile.firstName = nameParts[0];
      profile.lastName = nameParts.slice(1).join(' ');
    }

    return profile;
  } catch (error) {
    console.error('[LinkedIn to Affinity] Error parsing profile HTML:', error);
    return null;
  }
}

/**
 * Parse headline to extract title and company (fallback)
 */
function parseHeadlineForProfile(headline) {
  const result = { title: null, company: null };
  if (!headline) return result;

  // Common patterns
  const patterns = [
    /^(.+?)\s+(?:at|@)\s+(.+?)(?:\s*[|·•]|$)/i,  // "Title at Company"
    /^(.+?)\s*[|·•]\s*(.+?)(?:\s*[|·•]|$)/,       // "Title | Company"
    /^(.+?),\s*(.+?)(?:\s*[|·•]|$)/               // "Title, Company"
  ];

  for (const pattern of patterns) {
    const match = headline.match(pattern);
    if (match) {
      result.title = match[1]?.trim();
      result.company = match[2]?.trim();
      break;
    }
  }

  // If no company found, the whole thing might just be a title
  if (!result.title && headline.length < 100) {
    result.title = headline;
  }

  return result;
}

/**
 * Search for an organization in Affinity by name
 */
async function searchOrganization(name) {
  try {
    const result = await affinityRequest(`/organizations?term=${encodeURIComponent(name)}`);
    return result.organizations || [];
  } catch (error) {
    console.error('[LinkedIn to Affinity] Error searching organization:', error);
    return [];
  }
}

/**
 * Create a new organization in Affinity
 */
async function createOrganization(name, domain = null) {
  const payload = {
    name: name
  };

  if (domain) {
    payload.domain = domain;
  }

  try {
    const result = await affinityRequest('/organizations', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    return result;
  } catch (error) {
    console.error('[LinkedIn to Affinity] Error creating organization:', error);
    return null;
  }
}

/**
 * Find or create an organization in Affinity
 */
async function findOrCreateOrganization(companyName) {
  if (!companyName) return null;

  // Search for existing organization
  const matches = await searchOrganization(companyName);

  if (matches.length > 0) {
    // Only reuse a match whose name matches EXACTLY (case-insensitive). Affinity's
    // term search is fuzzy, and blindly taking matches[0] linked contacts to the
    // wrong company. A wrong link is worse (and harder to spot) than a duplicate.
    const want = companyName.trim().toLowerCase();
    const exact = matches.find(m => (m.name || '').trim().toLowerCase() === want);
    if (exact) {
      console.log('[LinkedIn to Affinity] Found existing organization (exact match):', exact.name);
      return exact;
    }
    console.warn(`[LinkedIn to Affinity] Org search for "${companyName}" returned ${matches.length} fuzzy match(es) but no exact name match — creating a new org rather than risk a wrong link.`);
  }

  // Create new organization
  console.log('[LinkedIn to Affinity] Creating new organization:', companyName);
  return await createOrganization(companyName);
}

/**
 * Get field definitions for persons specifically
 * Affinity has separate endpoints for different entity types
 */
async function getPersonFieldDefinitions() {
  try {
    // Use the persons/fields endpoint for person-specific fields
    const result = await affinityRequest('/persons/fields');
    // Debug log removed
    return result || [];
  } catch (error) {
    console.error('[LinkedIn to Affinity] Error getting person field definitions:', error);
    return [];
  }
}

/**
 * Add a field value to a person
 */
async function addFieldValue(fieldId, entityId, value) {
  try {
    const payload = {
      field_id: fieldId,
      entity_id: entityId,
      value: value
    };

    // Debug log removed
    const result = await affinityRequest('/field-values', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    // Debug log removed
    return result;
  } catch (error) {
    console.error('[LinkedIn to Affinity] Error adding field value:', error);
    return null;
  }
}

/**
 * Create a new field definition in Affinity
 * @param {string} name - Field name
 * @param {number} entityType - 0=Person, 1=Organization, 2=Opportunity
 * @param {number} valueType - 0=Person, 1=Org, 2=Dropdown, 3=Number, 4=Date, 5=Location, 6=Text
 */
async function createField(name, entityType, valueType) {
  try {
    const payload = {
      name: name,
      entity_type: entityType,
      value_type: valueType
    };

    console.log('[LinkedIn to Affinity] Creating field:', payload);
    const result = await affinityRequest('/fields', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    console.log('[LinkedIn to Affinity] Field created:', result);
    return result;
  } catch (error) {
    console.error('[LinkedIn to Affinity] Error creating field:', error);
    return null;
  }
}

/**
 * Cache for field definitions
 */
let fieldsCache = null;

/**
 * Cache for current user info
 */
let currentUserCache = null;

// ============================================================================
// Dashboard Caching
// ============================================================================

/** Full dashboard data cache */
let dashboardDataCache = null;
let dashboardDataCacheTime = 0;
const DASHBOARD_CACHE_TTL = 2 * 60 * 1000; // 2 minutes

/** List entry counts cache (counts change slowly) */
let listCountsCache = {};
let listCountsCacheTime = 0;
const LIST_COUNTS_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

/** Flag to prevent concurrent refreshes */
let dashboardRefreshInProgress = false;

/**
 * Get current user info (cached)
 */
async function getCurrentUser() {
  if (currentUserCache) return currentUserCache;

  try {
    const result = await affinityRequest('/whoami');
    if (result && result.grant) {
      currentUserCache = {
        firstName: result.grant.first_name,
        lastName: result.grant.last_name,
        email: result.grant.email
      };
      console.log('[LinkedIn to Affinity] Cached current user:', currentUserCache.firstName);
    }
    return currentUserCache;
  } catch (error) {
    console.error('[LinkedIn to Affinity] Error getting current user:', error);
    return null;
  }
}

/**
 * Reset caches (for testing)
 */
function resetCaches() {
  fieldsCache = null;
  currentUserCache = null;
  dashboardDataCache = null;
  dashboardDataCacheTime = 0;
  listCountsCache = {};
  listCountsCacheTime = 0;
}

/**
 * Find relevant fields in Affinity for person data (cached)
 * Returns an object mapping field types to field definitions
 */
async function findPersonFields() {
  if (fieldsCache !== null) return fieldsCache;

  // Use the person-specific fields endpoint
  const personFields = await getPersonFieldDefinitions();

  // Handle case where fields is not an array
  if (!Array.isArray(personFields)) {
    console.log('[LinkedIn to Affinity] No person field definitions available');
    fieldsCache = { _all: [] };
    return fieldsCache;
  }

  // Map common field names to their definitions
  // value_type: 0 = Person, 1 = Organization, 2 = Dropdown, 3 = Number, 4 = Date, 5 = Location, 6 = Text, 7 = Ranked Dropdown
  fieldsCache = {
    // LinkedIn URL - Text field (value_type 6)
    linkedin: personFields.find(f =>
      (f.name?.toLowerCase() === 'linkedin url' ||
       f.name?.toLowerCase() === 'linkedin profile url' ||
       f.name?.toLowerCase() === 'linkedin') &&
      f.value_type === 6
    ),
    // Headline - Text field (value_type 6)
    headline: personFields.find(f =>
      (f.name?.toLowerCase() === 'linkedin profile headline' ||
       f.name?.toLowerCase() === 'headline' ||
       f.name?.toLowerCase() === 'profile headline') &&
      f.value_type === 6
    ),
    // Current Job Title - Text (6) or Dropdown (2)
    currentJobTitle: personFields.find(f =>
      (f.name?.toLowerCase() === 'current job title' ||
       f.name?.toLowerCase() === 'job title' ||
       f.name?.toLowerCase() === 'current title' ||
       f.name?.toLowerCase() === 'title' ||
       f.name?.toLowerCase() === 'position' ||
       f.name?.toLowerCase() === 'role') &&
      (f.value_type === 6 || f.value_type === 2)
    ),
    // Job Titles - Text (6) or Dropdown (2)
    jobTitles: personFields.find(f =>
      (f.name?.toLowerCase() === 'job titles' ||
       f.name?.toLowerCase() === 'all job titles' ||
       f.name?.toLowerCase() === 'past titles' ||
       f.name?.toLowerCase() === 'positions') &&
      (f.value_type === 6 || f.value_type === 2)
    ),
    // Location - Text or Location field (value_type 5 or 6)
    location: personFields.find(f =>
      (f.name?.toLowerCase() === 'location' ||
       f.name?.toLowerCase() === 'city' ||
       f.name?.toLowerCase() === 'region' ||
       f.name?.toLowerCase() === 'address') &&
      (f.value_type === 5 || f.value_type === 6)
    ),
    // Industry - Text or Dropdown field (value_type 2 or 6)
    industry: personFields.find(f =>
      (f.name?.toLowerCase() === 'industry' ||
       f.name?.toLowerCase() === 'sector') &&
      (f.value_type === 2 || f.value_type === 6)
    ),
    // Phone Number - Text field (value_type 6)
    phone: personFields.find(f =>
      (f.name?.toLowerCase() === 'phone number' ||
       f.name?.toLowerCase() === 'phone' ||
       f.name?.toLowerCase() === 'mobile' ||
       f.name?.toLowerCase() === 'cell') &&
      f.value_type === 6
    ),
    // Bio/About - Text field (value_type 6)
    bio: personFields.find(f =>
      (f.name?.toLowerCase() === 'bio' ||
       f.name?.toLowerCase() === 'about' ||
       f.name?.toLowerCase() === 'summary' ||
       f.name?.toLowerCase() === 'description' ||
       f.name?.toLowerCase() === 'notes') &&
      f.value_type === 6
    ),
    // Source of Introduction - Dropdown field (value_type 2)
    sourceOfIntroduction: personFields.find(f =>
      (f.name?.toLowerCase() === 'source of introduction' ||
       f.name?.toLowerCase() === 'introduction source' ||
       f.name?.toLowerCase() === 'source') &&
      f.value_type === 2 // Dropdown type
    ),
    // Fallback: Source as text field
    sourceText: personFields.find(f =>
      (f.name?.toLowerCase() === 'source' ||
       f.name?.toLowerCase() === 'lead source' ||
       f.name?.toLowerCase() === 'how we met') &&
      f.value_type === 6 // Text type
    ),
    // Contact Type / Relationship Type - Dropdown (2) or Text (6)
    contactType: personFields.find(f =>
      (f.name?.toLowerCase() === 'contact type' ||
       f.name?.toLowerCase() === 'relationship type' ||
       f.name?.toLowerCase() === 'type' ||
       f.name?.toLowerCase() === 'category' ||
       f.name?.toLowerCase() === 'tag' ||
       f.name?.toLowerCase() === 'tags') &&
      (f.value_type === 2 || f.value_type === 6)
    ),
    // Profile Photo URL - Text field (value_type 6)
    profilePhoto: personFields.find(f =>
      (f.name?.toLowerCase() === 'profile photo' ||
       f.name?.toLowerCase() === 'profile photo url' ||
       f.name?.toLowerCase() === 'photo url' ||
       f.name?.toLowerCase() === 'photo' ||
       f.name?.toLowerCase() === 'avatar' ||
       f.name?.toLowerCase() === 'avatar url' ||
       f.name?.toLowerCase() === 'profile image' ||
       f.name?.toLowerCase() === 'linkedin photo') &&
      f.value_type === 6
    ),
    // Note: "Current Organization" is an Affinity Data enrichment field
    // and cannot be set via API - it's auto-populated by Affinity's system
    _all: personFields
  };

  console.log('[LinkedIn to Affinity] Found person fields:', {
    linkedin: fieldsCache.linkedin?.name,
    headline: fieldsCache.headline?.name,
    currentJobTitle: fieldsCache.currentJobTitle?.name,
    jobTitles: fieldsCache.jobTitles?.name,
    location: fieldsCache.location?.name,
    industry: fieldsCache.industry?.name,
    phone: fieldsCache.phone?.name,
    sourceOfIntroduction: fieldsCache.sourceOfIntroduction?.name,
    sourceText: fieldsCache.sourceText?.name,
    contactType: fieldsCache.contactType?.name,
    profilePhoto: fieldsCache.profilePhoto?.name,
    totalFields: personFields.length
  });

  return fieldsCache;
}

/**
 * Find dropdown option ID by name (case-insensitive) with fuzzy matching
 */
function findDropdownOption(field, optionName) {
  if (!field || !field.dropdown_options || !field.dropdown_options.length || !optionName) return null;

  const lowerName = optionName.toLowerCase().trim();
  const options = field.dropdown_options;

  // 1. Exact match
  let option = options.find(opt => opt.text?.toLowerCase().trim() === lowerName);
  if (option) return option.id;

  // 2. Contains match (option contains search term or vice versa)
  option = options.find(opt => {
    const optText = opt.text?.toLowerCase().trim();
    return optText?.includes(lowerName) || lowerName.includes(optText);
  });
  if (option) return option.id;

  // 3. Fuzzy match - find best similarity score
  let bestMatch = null;
  let bestScore = 0;

  for (const opt of options) {
    const optText = opt.text?.toLowerCase().trim();
    if (!optText) continue;

    const score = calculateSimilarity(lowerName, optText);
    if (score > bestScore && score > 0.4) { // Minimum 40% similarity threshold
      bestScore = score;
      bestMatch = opt;
    }
  }

  if (bestMatch) {
    console.log(`[LinkedIn to Affinity] Fuzzy matched "${optionName}" to "${bestMatch.text}" (${Math.round(bestScore * 100)}% match)`);
    return bestMatch.id;
  }

  return null;
}

/**
 * Calculate similarity between two strings (0-1 score)
 * Uses a combination of word overlap and character-level comparison
 */
function calculateSimilarity(str1, str2) {
  if (!str1 || !str2) return 0;
  if (str1 === str2) return 1;

  // Word-based similarity
  const words1 = str1.split(/\s+/).filter(w => w.length > 2);
  const words2 = str2.split(/\s+/).filter(w => w.length > 2);

  let wordMatches = 0;
  for (const w1 of words1) {
    for (const w2 of words2) {
      if (w1 === w2 || w1.includes(w2) || w2.includes(w1)) {
        wordMatches++;
        break;
      }
    }
  }

  const wordScore = words1.length > 0 ? wordMatches / Math.max(words1.length, words2.length) : 0;

  // Character-level similarity (Dice coefficient)
  const bigrams1 = getBigrams(str1);
  const bigrams2 = getBigrams(str2);

  let matches = 0;
  for (const bg of bigrams1) {
    if (bigrams2.has(bg)) matches++;
  }

  const charScore = bigrams1.size + bigrams2.size > 0
    ? (2 * matches) / (bigrams1.size + bigrams2.size)
    : 0;

  // Combined score (weight word matches more heavily)
  return (wordScore * 0.6) + (charScore * 0.4);
}

/**
 * Get bigrams (2-character sequences) from a string
 */
function getBigrams(str) {
  const bigrams = new Set();
  for (let i = 0; i < str.length - 1; i++) {
    bigrams.add(str.substring(i, i + 2));
  }
  return bigrams;
}

/**
 * Populate all matching fields for a person
 * @param {number} personId - The Affinity person ID
 * @param {object} profileData - Profile data including linkedinUrl, headline, etc.
 * @param {boolean} isNewPerson - Whether this is a newly created person
 * @param {array} tags - Optional array of contact type tags (e.g., ["Founder", "LP"])
 */
async function populatePersonFields(personId, profileData, isNewPerson = true, tags = []) {
  const fields = await findPersonFields();
  const fieldPromises = [];

  // LinkedIn URL
  if (fields.linkedin && profileData.linkedinUrl) {
    fieldPromises.push(
      addFieldValue(fields.linkedin.id, personId, profileData.linkedinUrl)
        .then(result => result ? { field: 'linkedin', success: true } : null)
        .catch(() => null)
    );
  }

  // LinkedIn Profile Headline
  if (fields.headline && profileData.headline) {
    fieldPromises.push(
      addFieldValue(fields.headline.id, personId, profileData.headline)
        .then(result => result ? { field: 'headline', success: true } : null)
        .catch(() => null)
    );
  }

  // Current Job Title (prefer currentJobTitle, fall back to title)
  // Note: Affinity dropdown fields accept any text value directly
  const currentTitle = profileData.currentJobTitle || profileData.title;
  if (fields.currentJobTitle && currentTitle) {
    fieldPromises.push(
      addFieldValue(fields.currentJobTitle.id, personId, currentTitle)
        .then(result => result ? { field: 'currentJobTitle', success: true } : null)
        .catch(() => null)
    );
  }

  // All Job Titles - concatenate all titles
  // Note: Affinity dropdown fields accept any text value directly
  if (fields.jobTitles && profileData.allJobTitles && profileData.allJobTitles.length > 0) {
    const titlesText = profileData.allJobTitles.join(', ');
    fieldPromises.push(
      addFieldValue(fields.jobTitles.id, personId, titlesText)
        .then(result => result ? { field: 'jobTitles', success: true } : null)
        .catch(() => null)
    );
  }

  // Location - handle both text (type 6) and location (type 5) field types
  if (fields.location && profileData.location) {
    if (fields.location.value_type === 6) {
      // Text field - just set the string
      fieldPromises.push(
        addFieldValue(fields.location.id, personId, profileData.location)
          .then(result => result ? { field: 'location', success: true } : null)
          .catch(() => null)
      );
    } else if (fields.location.value_type === 5) {
      // Location field type - requires structured data
      fieldPromises.push(
        addFieldValue(fields.location.id, personId, { city: profileData.location, country: null })
          .then(result => result ? { field: 'location', success: true } : null)
          .catch(() => {
            console.log('[LinkedIn to Affinity] Location field requires structured data, skipping:', profileData.location);
            return null;
          })
      );
    }
  }

  // Industry
  // Note: Affinity dropdown fields accept any text value directly
  if (fields.industry && profileData.industry) {
    fieldPromises.push(
      addFieldValue(fields.industry.id, personId, profileData.industry)
        .then(result => result ? { field: 'industry', success: true } : null)
        .catch(() => null)
    );
  }

  // Phone Number (if available - usually not from LinkedIn)
  if (fields.phone && profileData.phone) {
    fieldPromises.push(
      addFieldValue(fields.phone.id, personId, profileData.phone)
        .then(result => result ? { field: 'phone', success: true } : null)
        .catch(() => null)
    );
  }

  // Bio/About
  if (fields.bio && profileData.about) {
    // Truncate if too long
    const bio = profileData.about.length > 2000
      ? profileData.about.substring(0, 2000) + '...'
      : profileData.about;
    fieldPromises.push(
      addFieldValue(fields.bio.id, personId, bio)
        .then(result => result ? { field: 'bio', success: true } : null)
        .catch(() => null)
    );
  }

  // Profile Photo URL
  if (fields.profilePhoto && profileData.profileImageUrl) {
    fieldPromises.push(
      addFieldValue(fields.profilePhoto.id, personId, profileData.profileImageUrl)
        .then(result => result ? { field: 'profilePhoto', success: true } : null)
        .catch(() => null)
    );
  }

  // Source of Introduction (only for new persons)
  if (isNewPerson) {
    // Try dropdown field first
    if (fields.sourceOfIntroduction) {
      const optionId = findDropdownOption(fields.sourceOfIntroduction, 'LinkedIn');
      if (optionId) {
        fieldPromises.push(
          addFieldValue(fields.sourceOfIntroduction.id, personId, optionId)
            .then(result => result ? { field: 'sourceOfIntroduction', success: true } : null)
            .catch(() => null)
        );
      } else {
        console.log('[LinkedIn to Affinity] LinkedIn option not found in Source of Introduction dropdown');
        console.log('[LinkedIn to Affinity] Available options:', fields.sourceOfIntroduction.dropdown_options?.map(o => o.text));
      }
    }
    // Fallback to text field
    else if (fields.sourceText) {
      fieldPromises.push(
        addFieldValue(fields.sourceText.id, personId, 'LinkedIn')
          .then(result => result ? { field: 'sourceText', success: true } : null)
          .catch(() => null)
      );
    }
  }

  // Note: "Current Organization" is an Affinity Data enrichment field
  // and cannot be set via API - enable Affinity Data enrichment in settings

  // Contact Type / Tags (from VC workflow)
  if (tags && tags.length > 0) {
    const tagsValue = tags.join(', ');
    let contactTypeField = fields.contactType;

    // Auto-create "Contact Type" field if it doesn't exist
    if (!contactTypeField) {
      console.log('[LinkedIn to Affinity] Contact Type field not found, creating it...');
      const newField = await createField('Contact Type', 0, 6); // 0=Person, 6=Text
      if (newField && newField.id) {
        contactTypeField = newField;
        // Clear cache so it's picked up next time
        fieldsCache = null;
        console.log('[LinkedIn to Affinity] Created Contact Type field:', newField.id);
      }
    }

    if (contactTypeField) {
      fieldPromises.push(
        addFieldValue(contactTypeField.id, personId, tagsValue)
          .then(result => {
            if (result) {
              console.log('[LinkedIn to Affinity] Tags saved to field:', contactTypeField.name, '=', tagsValue);
              return { field: 'contactType', success: true, value: tagsValue };
            }
            return null;
          })
          .catch((err) => {
            console.error('[LinkedIn to Affinity] Error saving tags:', err);
            return null;
          })
      );
    } else {
      console.log('[LinkedIn to Affinity] Could not create Contact Type field. Tags will only appear in notes.');
    }
  }

  // Run all field updates in parallel for speed
  const allResults = await Promise.all(fieldPromises);
  const results = allResults.filter(r => r !== null);

  console.log('[LinkedIn to Affinity] Populated fields:', results);
  return results;
}

/**
 * Create a new person in Affinity with full profile data
 */
async function createPerson(personData, tags = []) {
  // Enrich data by fetching the actual LinkedIn profile
  let enrichedData = { ...personData };

  if (personData.linkedinUrl) {
    const profileData = await fetchLinkedInProfile(personData.linkedinUrl);
    // Debug log removed

    if (profileData) {

      // Merge profile data, preferring fetched data over parsed headline data
      // Note: Voyager API data (allCompanies, allJobTitles, currentJobTitle, industry)
      // comes from personData via content.js
      enrichedData = {
        ...personData,
        name: profileData.name || personData.name,
        firstName: profileData.firstName || personData.firstName,
        lastName: profileData.lastName || personData.lastName,
        title: profileData.title || personData.title,
        company: profileData.company || personData.company,
        headline: profileData.headline || personData.headline,
        location: profileData.location || personData.location,
        about: profileData.about,
        profileImageUrl: profileData.profileImageUrl || personData.profileImageUrl,
        // Voyager API data from content.js (keep as-is)
        allCompanies: personData.allCompanies,
        allJobTitles: personData.allJobTitles,
        currentJobTitle: personData.currentJobTitle,
        industry: personData.industry
      };
    } else {
      console.log('[LinkedIn to Affinity] No profile data extracted, using sender data only');
    }
  }

  // Build the person payload
  const payload = {
    first_name: enrichedData.firstName || enrichedData.name?.split(' ')[0] || 'Unknown',
    last_name: enrichedData.lastName || enrichedData.name?.split(' ').slice(1).join(' ') || '',
    emails: [] // LinkedIn doesn't expose emails
  };

  // Find or create organizations for all companies in work history
  const organizationIds = [];

  // Check if we have allCompanies from Voyager API (full work history)
  if (enrichedData.allCompanies && enrichedData.allCompanies.length > 0) {
    console.log('[LinkedIn to Affinity] Linking', enrichedData.allCompanies.length, 'organizations from work history (parallel)');

    // Parallelize organization lookups for faster processing
    const companiesToLink = enrichedData.allCompanies.filter(c => c.name);
    const orgPromises = companiesToLink.map(company =>
      findOrCreateOrganization(company.name)
        .then(org => ({ org, company }))
        .catch(error => {
          console.log('[LinkedIn to Affinity] Could not link organization:', company.name, error.message);
          return null;
        })
    );

    const orgResults = await Promise.all(orgPromises);
    for (const result of orgResults) {
      if (result && result.org && result.org.id && !organizationIds.includes(result.org.id)) {
        organizationIds.push(result.org.id);
        console.log('[LinkedIn to Affinity] Linked organization:', result.org.id, result.company.name, result.company.isCurrent ? '(current)' : '(past)');
      }
    }
  } else if (enrichedData.company) {
    // Fallback: use single company from headline
    console.log('[LinkedIn to Affinity] Looking for organization:', enrichedData.company);
    const org = await findOrCreateOrganization(enrichedData.company);
    if (org && org.id) {
      organizationIds.push(org.id);
      console.log('[LinkedIn to Affinity] Linking person to organization:', org.id, org.name);
    }
  } else {
    console.log('[LinkedIn to Affinity] No company name available for organization linking');
  }

  if (organizationIds.length > 0) {
    payload.organization_ids = organizationIds;
  }

  // Create the person
  const person = await affinityRequest('/persons', {
    method: 'POST',
    body: JSON.stringify(payload)
  });

  console.log('[LinkedIn to Affinity] Created person:', person.id, payload.first_name, payload.last_name);

  // Populate all matching custom fields (isNewPerson=true to set Source of Introduction)
  if (person.id) {
    await populatePersonFields(person.id, enrichedData, true, tags);
  }

  // Return enriched person data
  return {
    ...person,
    _enrichment: {
      company: enrichedData.company,
      title: enrichedData.title,
      linkedinUrl: enrichedData.linkedinUrl,
      location: enrichedData.location,
      about: enrichedData.about
    }
  };
}

/**
 * Add a note to a person in Affinity
 * Automatically appends syncer info
 */
async function addNote(personId, content, includeFooter = true) {
  // Get current user for attribution
  let finalContent = content;
  if (includeFooter) {
    const user = await getCurrentUser();
    if (user && user.firstName) {
      const syncerName = user.lastName ? `${user.firstName} ${user.lastName.charAt(0)}.` : user.firstName;
      finalContent = content.trimEnd() + `\n\n_Synced by ${syncerName}_`;
    }
  }

  const payload = {
    person_ids: [personId],
    content: finalContent
  };

  const result = await affinityRequest('/notes', {
    method: 'POST',
    body: JSON.stringify(payload)
  });

  return result;
}

/**
 * Update an existing note in Affinity
 */
async function updateNote(noteId, content) {
  const payload = {
    content: content
  };

  const result = await affinityRequest(`/notes/${noteId}`, {
    method: 'PUT',
    body: JSON.stringify(payload)
  });

  return result;
}

/**
 * Parse a message timestamp and extract the day key (YYYY-MM-DD)
 * Handles various timestamp formats from LinkedIn
 */
function parseMessageDay(message) {
  // Handle null/undefined
  if (!message) return null;

  // If message has pre-parsed date from content.js, use it
  if (typeof message === 'object' && message.date) {
    return message.date;
  }

  // Handle string timestamp (backwards compatibility)
  const timestamp = typeof message === 'object' ? message.timestamp : message;
  if (!timestamp) return null;

  const currentYear = new Date().getFullYear();
  const now = new Date();
  const today = toLocalDateString(now);
  const lowerTimestamp = timestamp.toLowerCase();

  // Handle relative timestamps
  if (lowerTimestamp.includes('today') || lowerTimestamp.includes('hour') ||
      lowerTimestamp.includes('minute') || lowerTimestamp.includes('just now')) {
    return today;
  }

  // Handle time-only timestamps (e.g., "10:10 PM", "6:32 AM") - assume today
  const timeOnlyMatch = timestamp.match(/^(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?$/);
  if (timeOnlyMatch) {
    return today;
  }

  if (lowerTimestamp.includes('yesterday')) {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    return toLocalDateString(yesterday);
  }

  // Days ago
  const daysAgoMatch = lowerTimestamp.match(/(\d+)\s*days?\s*ago/);
  if (daysAgoMatch) {
    const date = new Date(now);
    date.setDate(date.getDate() - parseInt(daysAgoMatch[1], 10));
    return toLocalDateString(date);
  }

  // Weeks ago
  const weeksAgoMatch = lowerTimestamp.match(/(\d+)\s*weeks?\s*ago/);
  if (weeksAgoMatch) {
    const date = new Date(now);
    date.setDate(date.getDate() - (parseInt(weeksAgoMatch[1], 10) * 7));
    return toLocalDateString(date);
  }

  // Months ago
  const monthsAgoMatch = lowerTimestamp.match(/(\d+)\s*months?\s*ago/);
  if (monthsAgoMatch) {
    const date = new Date(now);
    date.setMonth(date.getMonth() - parseInt(monthsAgoMatch[1], 10));
    return toLocalDateString(date);
  }

  // Check if this looks like a timestamp without a year (e.g., "Jan 15, 10:30 AM")
  const hasExplicitYear = /\b20\d{2}\b/.test(timestamp);

  if (!hasExplicitYear) {
    // Try to extract month and day
    const monthDayMatch = timestamp.match(/([A-Za-z]+)\s+(\d{1,2})/);
    if (monthDayMatch) {
      const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
      const monthIndex = monthNames.indexOf(monthDayMatch[1].toLowerCase().substring(0, 3));
      if (monthIndex !== -1) {
        const day = parseInt(monthDayMatch[2], 10);

        // If the date would be in the future, it must be from last year
        const candidateDate = new Date(currentYear, monthIndex, day);
        if (candidateDate > now) {
          return `${currentYear - 1}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        }

        return `${currentYear}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      }
    }
  }

  // Try standard date parsing for dates with explicit year or ISO format
  const date = new Date(timestamp);

  if (isNaN(date.getTime())) {
    return null;
  }

  // Sanity check: year should be reasonable (2020-2100)
  const parsedYear = date.getFullYear();
  if (parsedYear < 2020 || parsedYear > 2100) {
    return null;
  }

  return toLocalDateString(date); // YYYY-MM-DD
}

/**
 * Group messages by day
 * Returns a Map of dayKey -> messages array, sorted by date (oldest first)
 */
function groupMessagesByDay(messages) {
  if (!messages || messages.length === 0) return new Map();

  const groups = new Map();

  messages.forEach(msg => {
    // Pass full message object so parseMessageDay can use pre-parsed date
    const dayKey = parseMessageDay(msg) || 'unknown';
    if (!groups.has(dayKey)) {
      groups.set(dayKey, []);
    }
    groups.get(dayKey).push(msg);
  });

  // Sort by day (oldest first) and return
  const sortedEntries = [...groups.entries()].sort((a, b) => {
    if (a[0] === 'unknown') return 1;
    if (b[0] === 'unknown') return -1;
    return a[0].localeCompare(b[0]);
  });

  return new Map(sortedEntries);
}

/**
 * Format day key for display (YYYY-MM-DD -> "Mon, Jan 15, 2024")
 */
function formatDayKeyForDisplay(dayKey) {
  if (dayKey === 'unknown') return 'Unknown Date';

  const date = new Date(dayKey + 'T12:00:00'); // Add time to avoid timezone issues
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

/**
 * Format the LinkedIn conversation as a note
 * Clean format with full sender names and date/time
 */
function formatConversationNote(data) {
  const { sender, messages, conversationUrl, capturedAt, quickNote, tags } = data;

  const senderName = sender?.name || 'Unknown';
  const capturedDate = new Date(capturedAt);
  const dayKey = toLocalDateString(capturedDate);

  // Extract thread ID
  const threadIdMatch = conversationUrl.match(/\/(?:thread|conversation)\/([^/?]+)/);
  const threadId = threadIdMatch ? threadIdMatch[1] : '';

  // Build note
  let note = '';

  // Link first
  note += `${conversationUrl}\n`;
  note += `${dayKey} · ${threadId}\n\n`;

  // Tags inline if present
  if (tags && tags.length > 0) {
    note += `${tags.join(' · ')}\n\n`;
  }

  // Quick note if present
  if (quickNote) {
    note += `> ${quickNote}\n\n`;
  }

  // Messages with full sender name and date/time
  if (messages && messages.length > 0) {
    messages.forEach((msg) => {
      // Get the actual sender name from the message, or use context
      const msgSender = msg.sender || (msg.isIncoming ? senderName : 'You');

      // Format date as YY/MM/DD
      const msgDate = msg.date || dayKey;
      const datePart = msgDate ? msgDate.substring(2).replace(/-/g, '/') : '';

      // Get time display
      const timePart = msg.timestampDisplay || '';

      // Combine date and time
      const dateTimeStr = datePart && timePart ? `${datePart} ${timePart}` : (timePart || datePart);

      note += `**${msgSender}** (${dateTimeStr}):\n`;
      note += `${msg.content || ''}\n\n`;
    });
  }

  return note;
}

/**
 * Format a day-specific conversation note
 * Clean format with full sender names and date/time
 */
function formatDayConversationNote(data, dayKey, dayMessages) {
  const { sender, conversationUrl, quickNote, tags } = data;

  const senderName = sender?.name || 'Unknown';

  // Extract thread ID for tracking
  const threadIdMatch = conversationUrl.match(/\/(?:thread|conversation)\/([^/?]+)/);
  const threadId = threadIdMatch ? threadIdMatch[1] : '';

  // Build note
  let note = '';

  // Link first
  note += `${conversationUrl}\n`;
  note += `${dayKey} · ${threadId}\n\n`;

  // Tags inline if present
  if (tags && tags.length > 0) {
    note += `${tags.join(' · ')}\n\n`;
  }

  // Quick note if present
  if (quickNote) {
    note += `> ${quickNote}\n\n`;
  }

  // Messages with full sender name and date/time
  if (dayMessages && dayMessages.length > 0) {
    dayMessages.forEach((msg) => {
      // Get the actual sender name from the message, or use context
      const msgSender = msg.sender || (msg.isIncoming ? senderName : 'You');

      // Format date as YY/MM/DD from the message's date or dayKey
      const msgDate = msg.date || dayKey;
      const datePart = msgDate ? msgDate.substring(2).replace(/-/g, '/') : '';

      // Get time display
      const timePart = msg.timestampDisplay || '';

      // Combine date and time
      const dateTimeStr = datePart && timePart ? `${datePart} ${timePart}` : (timePart || datePart);

      note += `**${msgSender}** (${dateTimeStr}):\n`;
      note += `${msg.content || ''}\n\n`;
    });
  }

  return note;
}

/**
 * Extract existing messages from a note's content
 * Supports multiple formats for backwards compatibility
 */
function extractMessagesFromNote(noteContent) {
  const messages = new Set();

  if (!noteContent) return messages;

  // Normalize content that Affinity might have transformed
  // Unescape asterisks that Affinity escapes - handle multiple levels of escaping
  // Each update doubles the escapes: ** -> \*\* -> \\*\\* -> \\\*\\\*
  // First remove all backslashes before asterisks (handles any level of escaping)
  let normalized = noteContent.replace(/\\+\*/g, '*');
  // Convert <br> and <br/> to newlines
  normalized = normalized.replace(/<br\s*\/?>/gi, '\n');
  // Convert <strong> and <b> back to **
  normalized = normalized.replace(/<strong>([^<]*)<\/strong>/gi, '**$1**');
  normalized = normalized.replace(/<b>([^<]*)<\/b>/gi, '**$1**');
  // Strip other HTML tags but keep content
  normalized = normalized.replace(/<[^>]+>/g, '');

  const lines = normalized.split('\n');
  let currentMessage = '';
  let inMessage = false;

  // Helper to check if a line is a message header
  const isMessageHeader = (line) => {
    if (!line) return false;
    // New format: **Name** (date/time):
    if (line.match(/^\*\*[^*]+\*\*\s*\([^)]*\):\s*$/)) return true;
    // Arrow format: ← **Name** or → **You**
    if (line.match(/^[←→]\s+\*\*/)) return true;
    // Old format: **◀︎ or **▶︎
    if (line.startsWith('**◀︎') || line.startsWith('**▶︎')) return true;
    return false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check if this line is a message header
    if (isMessageHeader(line)) {
      // Save previous message
      if (currentMessage.trim()) {
        messages.add(currentMessage.trim());
      }
      currentMessage = '';
      inMessage = true;
      continue;
    }

    // Collect message content
    if (inMessage) {
      // Old format: blockquote lines
      if (line.startsWith('> ')) {
        currentMessage += (currentMessage ? '\n' : '') + line.substring(2);
      }
      // Plain text until next message header or empty line
      // Note: We include http lines here since they can be message content (URLs shared in chat)
      // The conversation URL at the top is before any message header, so inMessage will be false
      else if (line.trim() && !line.startsWith('---')) {
        currentMessage += (currentMessage ? '\n' : '') + line;
      }
      // Empty line might end the message
      else if (line.trim() === '' && currentMessage.trim()) {
        // Check if next non-empty line is a message header
        let nextLine = '';
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].trim()) {
            nextLine = lines[j];
            break;
          }
        }
        if (isMessageHeader(nextLine)) {
          messages.add(currentMessage.trim());
          currentMessage = '';
        }
      }
    }
  }

  // Don't forget the last message
  if (currentMessage.trim()) {
    messages.add(currentMessage.trim());
  }

  return messages;
}

/**
 * Append messages to an existing note
 * Returns the updated note content
 */
function appendMessagesToNote(existingContent, newMessages, senderName) {
  if (!newMessages || newMessages.length === 0) return existingContent;

  // Format new messages
  let appendContent = '';
  newMessages.forEach(msg => {
    // Get the actual sender name from the message, or use context
    const msgSender = msg.sender || (msg.isIncoming ? senderName : 'You');

    // Format date as YY/MM/DD
    const msgDate = msg.date || '';
    const datePart = msgDate ? msgDate.substring(2).replace(/-/g, '/') : '';

    // Get time display
    const timePart = msg.timestampDisplay || '';

    // Combine date and time
    const dateTimeStr = datePart && timePart ? `${datePart} ${timePart}` : (timePart || datePart);

    appendContent += `**${msgSender}** (${dateTimeStr}):\n`;
    appendContent += `${msg.content || ''}\n\n`;
  });

  // Append to the end
  return existingContent.trimEnd() + '\n\n' + appendContent;
}

/**
 * Get notes for a person from Affinity
 */
async function getNotesForPerson(personId) {
  try {
    const result = await affinityRequest(`/notes?person_id=${personId}`);
    const notes = result.notes || result || [];
    console.log('[LinkedIn to Affinity] getNotesForPerson raw result:', JSON.stringify(result).substring(0, 500));
    console.log('[LinkedIn to Affinity] getNotesForPerson notes count:', notes.length);
    if (notes.length > 0) {
      console.log('[LinkedIn to Affinity] First note preview:', notes[0]?.content?.substring(0, 200));
    }
    return notes;
  } catch (error) {
    console.error('[LinkedIn to Affinity] Error getting notes:', error);
    // Do NOT return [] here: a fetch failure is indistinguishable from "no notes",
    // and the duplicate check would then re-post the whole conversation. Propagate
    // so the caller can fail closed.
    throw error;
  }
}

/**
 * Normalize LinkedIn URL for comparison (remove query params, trailing slashes, normalize domain)
 */
function normalizeLinkedInUrl(url) {
  if (!url) return '';
  try {
    // Remove query parameters and hash
    const urlObj = new URL(url);
    let path = urlObj.pathname;
    // Remove trailing slashes
    path = path.replace(/\/+$/, '');
    // Normalize to www.linkedin.com (some URLs might not have www)
    const host = urlObj.host.replace(/^(www\.)?/, 'www.');
    return `https://${host}${path}`;
  } catch (e) {
    // If URL parsing fails, just do basic cleanup
    let cleaned = url.split('?')[0].split('#')[0].replace(/\/+$/, '');
    // Normalize www
    cleaned = cleaned.replace(/https?:\/\/(www\.)?linkedin\.com/, 'https://www.linkedin.com');
    return cleaned;
  }
}

/**
 * Extract thread ID from LinkedIn messaging URL
 */
function extractThreadId(url) {
  if (!url) return null;
  const match = url.match(/\/(?:thread|conversation)\/([^/?]+)/);
  return match ? match[1] : null;
}

/**
 * Check if a conversation has already been sent to Affinity and extract existing messages
 * Returns notes grouped by day for the day-based workflow
 */
async function checkDuplicateAndGetExistingMessages(conversationUrl, personId) {
  try {
    // Get notes for this person from Affinity
    const notes = await getNotesForPerson(personId);
    const existingMessageContents = new Set();
    const notesByDay = new Map(); // dayKey -> { noteId, content, messages }
    let latestNoteDate = null;
    let foundConversation = false;

    // Normalize URL for comparison (LinkedIn URLs can have varying query params)
    const normalizedUrl = normalizeLinkedInUrl(conversationUrl);
    // Also extract thread ID for more robust matching
    const threadId = extractThreadId(conversationUrl);

    console.log('[LinkedIn to Affinity] Checking duplicates - personId:', personId, 'notes found:', notes.length);
    console.log('[LinkedIn to Affinity] Looking for URL:', normalizedUrl, 'threadId:', threadId);

    // Check all notes for this conversation URL and extract message contents
    for (const note of notes) {
      if (!note.content) {
        console.log('[LinkedIn to Affinity] Note has no content, skipping:', note.id);
        continue;
      }

      // Check for URL match (normalized) or thread ID match or day marker
      // Support both http and https, with or without www
      const noteNormalizedUrls = note.content.match(/https?:\/\/(?:www\.)?linkedin\.com\/messaging\/[^\s)>\]]+/g) || [];

      // Look for day marker in new minimal format (second line): "Jan 15, 2024 · 2024-01-15 · threadId"
      const newDayMarkerMatch = note.content.match(/\n[A-Za-z]+ \d+, \d{4} · (\d{4}-\d{2}-\d{2}) · ([^\n]+)/);
      // Also support old emoji format: 📆 *Day: YYYY-MM-DD | Thread: xxx*
      const emojiDayMarkerMatch = note.content.match(/📆 \*Day: (\d{4}-\d{2}-\d{2}) \| Thread: ([^*]+)\*/);
      // Also support old HTML comment format for backwards compatibility
      const oldDayMarkerMatch = note.content.match(/<!-- day:(\d{4}-\d{2}-\d{2}) thread:([^\s]+) -->/);
      const effectiveDayMarker = newDayMarkerMatch || emojiDayMarkerMatch || oldDayMarkerMatch;

      const urlMatches = noteNormalizedUrls.some(noteUrl => {
        const normalizedNoteUrl = normalizeLinkedInUrl(noteUrl);
        return normalizedNoteUrl === normalizedUrl;
      });

      // Also check thread ID as fallback (more robust matching)
      const threadIdMatches = threadId && (
        note.content.includes(threadId) ||
        (effectiveDayMarker && effectiveDayMarker[2].includes(threadId))
      );

      if (urlMatches || threadIdMatches) {
        foundConversation = true;
        console.log('[LinkedIn to Affinity] Found matching note:', note.id, 'urlMatches:', urlMatches, 'threadIdMatches:', threadIdMatches);

        // Track the latest note date
        if (note.created_at) {
          const noteDate = new Date(note.created_at);
          if (!latestNoteDate || noteDate > latestNoteDate) {
            latestNoteDate = noteDate;
          }
        }

        // Extract day key from note (from day marker or created_at)
        let dayKey = null;
        if (effectiveDayMarker) {
          dayKey = effectiveDayMarker[1];
          console.log('[LinkedIn to Affinity] Found day marker in note:', dayKey);
        } else if (note.created_at) {
          dayKey = note.created_at.split('T')[0];
          console.log('[LinkedIn to Affinity] Using created_at date for note:', dayKey);
        }

        // Extract messages from this note using the new format
        const noteMessages = extractMessagesFromNote(note.content);

        // Add to notesByDay map
        if (dayKey) {
          notesByDay.set(dayKey, {
            noteId: note.id,
            content: note.content,
            messages: noteMessages
          });
          console.log('[LinkedIn to Affinity] Note', note.id, 'is for day:', dayKey, 'with', noteMessages.size, 'messages');
        }

        // Also add to global existing messages set (for backwards compatibility)
        noteMessages.forEach(msg => existingMessageContents.add(msg));

        // Fallback: also try old format extraction
        const separatorIdx = note.content.indexOf('---');
        if (separatorIdx > 0) {
          const messageSection = note.content.substring(separatorIdx);
          const messagePattern = /\):\n+([^\n]+)/g;
          let match;
          while ((match = messagePattern.exec(messageSection)) !== null) {
            const content = match[1].trim();
            if (content && content !== '_No messages extracted_' && content !== '---' && !content.startsWith('>')) {
              existingMessageContents.add(content);
            }
          }
        }
      }
    }

    console.log('[LinkedIn to Affinity] Duplicate check result:', {
      isDuplicate: foundConversation,
      existingMessages: existingMessageContents.size,
      daysFound: notesByDay.size
    });

    return {
      isDuplicate: foundConversation,
      sentAt: latestNoteDate?.toISOString() || null,
      existingMessageContents: existingMessageContents,
      notesByDay: notesByDay
    };
  } catch (error) {
    console.error('[LinkedIn to Affinity] Error checking duplicate:', error);
    // Fail CLOSED: we could not read existing notes, so we must NOT claim "not a
    // duplicate" — that silently re-posts the entire conversation on a transient
    // API blip. Flag the failure so the caller aborts (forceSend can override).
    return { verificationFailed: true, isDuplicate: false, existingMessageContents: new Set(), notesByDay: new Map() };
  }
}

/**
 * Normalize message content for comparison
 * Handles escape characters and other variations that can cause mismatches
 */
function normalizeMessageContent(content) {
  if (!content) return '';
  let normalized = content.trim();

  // Handle multiple levels of escaping (e.g., \\' -> ' and \' -> ')
  // Run replacement twice to handle double-escaping
  for (let i = 0; i < 2; i++) {
    normalized = normalized
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }

  return normalized
    // Normalize whitespace
    .replace(/\s+/g, ' ')
    // Normalize quotes (curly quotes to straight)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"');
}

/**
 * Filter out messages that have already been sent
 */
function filterNewMessages(messages, existingMessageContents) {
  if (!existingMessageContents || existingMessageContents.size === 0) {
    return messages;
  }

  // Create a normalized set for comparison
  const normalizedExisting = new Set(
    Array.from(existingMessageContents).map(msg => normalizeMessageContent(msg))
  );

  console.log('[LinkedIn to Affinity] Existing messages (normalized):', Array.from(normalizedExisting).map(m => m.substring(0, 50)));

  return messages.filter(msg => {
    const content = msg.content?.trim();
    const normalizedContent = normalizeMessageContent(content);
    const isExisting = normalizedExisting.has(normalizedContent);
    console.log('[LinkedIn to Affinity] Checking message:', JSON.stringify(normalizedContent.substring(0, 50)), 'exists:', isExisting);
    return content && !isExisting;
  });
}

/**
 * Main handler: Process LinkedIn conversation and send to Affinity
 * Always returns matches for user selection (never auto-sends)
 */
async function sendToAffinity(data) {
  const { sender } = data;

  // Step 1: Search for existing persons
  let existingPersons = [];

  if (sender.name) {
    existingPersons = await searchPerson(sender.name);
    console.log('[LinkedIn to Affinity] Found matches:', existingPersons.length);
  }

  // Always return for user selection (even with 0 or 1 match)
  // This lets user confirm where to send or create new contact
  return {
    success: false,
    needsSelection: true,
    matches: existingPersons.slice(0, 10), // Limit to 10 matches
    conversationData: data
  };
}

/**
 * Send conversation to a specific person (after user selection)
 * Groups messages by day and creates/updates notes accordingly
 * @param {boolean} forceSend - If true, skip duplicate check
 */
async function sendToAffinityWithPerson(personId, conversationData, forceSend = false) {
  console.log('[LinkedIn to Affinity] sendToAffinityWithPerson - personId:', personId, 'forceSend:', forceSend);
  console.log('[LinkedIn to Affinity] conversationUrl:', conversationData.conversationUrl);

  const senderName = conversationData.sender?.name || 'Unknown';

  // Check for existing messages and get notes by day
  const duplicateCheck = await checkDuplicateAndGetExistingMessages(conversationData.conversationUrl, personId);

  // Fail CLOSED on a verification failure: if we couldn't read existing notes we
  // don't know whether this is a duplicate, so creating notes now risks posting the
  // whole conversation twice. Abort with a retryable error; forceSend overrides.
  if (duplicateCheck.verificationFailed && !forceSend) {
    console.warn('[LinkedIn to Affinity] Duplicate verification failed — aborting to avoid a duplicate note.');
    return {
      success: false,
      needsRetry: true,
      personId: personId,
      error: 'Could not verify existing notes (Affinity API error). Not sending, to avoid a duplicate — please retry, or use Force Send to override.'
    };
  }

  // Filter to only new messages (not already in any note)
  const originalMessages = conversationData.messages || [];

  // Log sample message timestamps to help debug day parsing
  if (originalMessages.length > 0) {
    console.log('[LinkedIn to Affinity] Sample message timestamps:', originalMessages.slice(0, 3).map(m => m.timestamp));
  }

  const newMessages = filterNewMessages(originalMessages, duplicateCheck.existingMessageContents);

  console.log('[LinkedIn to Affinity] Message filtering - original:', originalMessages.length, 'new:', newMessages.length, 'isDuplicate:', duplicateCheck.isDuplicate);
  console.log('[LinkedIn to Affinity] Existing notes by day:', Array.from(duplicateCheck.notesByDay.keys()));

  // If no new messages and not force sending, show duplicate warning
  if (!forceSend && newMessages.length === 0 && duplicateCheck.isDuplicate) {
    console.log('[LinkedIn to Affinity] Returning duplicate warning');
    const dateStr = duplicateCheck.sentAt
      ? new Date(duplicateCheck.sentAt).toLocaleDateString()
      : 'a previous date';
    return {
      success: false,
      isDuplicate: true,
      sentAt: duplicateCheck.sentAt,
      personId: personId,
      error: `All messages were already sent on ${dateStr}`
    };
  }

  // If no new messages at all, just return success with 0 count
  if (newMessages.length === 0) {
    // Apply tags if provided (for existing contacts)
    const tags = conversationData.tags || [];
    if (tags.length > 0) {
      console.log('[LinkedIn to Affinity] Applying tags to existing contact:', tags);
      await populatePersonFields(personId, conversationData.sender || {}, false, tags);
    }
    return {
      success: true,
      personId: personId,
      isNewPerson: false,
      newMessageCount: 0
    };
  }

  // Group new messages by day
  const messagesByDay = groupMessagesByDay(newMessages);
  const dayKeys = [...messagesByDay.keys()];
  console.log('[LinkedIn to Affinity] Messages grouped into', messagesByDay.size, 'day(s):', dayKeys.join(', '));

  // Log each day's message count for verification
  dayKeys.forEach(day => {
    const count = messagesByDay.get(day).length;
    console.log(`[LinkedIn to Affinity] Day ${day}: ${count} message(s)`);
  });

  const results = {
    notesCreated: 0,
    notesUpdated: 0,
    totalNewMessages: 0
  };

  // Process each day
  for (const [dayKey, dayMessages] of messagesByDay) {
    console.log('[LinkedIn to Affinity] Processing day:', dayKey, 'with', dayMessages.length, 'messages');

    // Check if there's an existing note for this day
    const existingDayNote = duplicateCheck.notesByDay.get(dayKey);

    if (existingDayNote) {
      // Append to existing note
      console.log('[LinkedIn to Affinity] Found existing note for day', dayKey, '- appending', dayMessages.length, 'messages');

      // Filter out any messages that might already be in this specific note
      const existingDayMessages = existingDayNote.messages || new Set();
      const normalizedExisting = new Set(
        Array.from(existingDayMessages).map(msg => normalizeMessageContent(msg))
      );

      const trulyNewMessages = dayMessages.filter(msg => {
        const normalized = normalizeMessageContent(msg.content);
        return !normalizedExisting.has(normalized);
      });

      if (trulyNewMessages.length > 0) {
        const updatedContent = appendMessagesToNote(existingDayNote.content, trulyNewMessages, senderName);
        await updateNote(existingDayNote.noteId, updatedContent);
        results.notesUpdated++;
        results.totalNewMessages += trulyNewMessages.length;
        console.log('[LinkedIn to Affinity] Updated note', existingDayNote.noteId, 'with', trulyNewMessages.length, 'new messages');
      } else {
        console.log('[LinkedIn to Affinity] No truly new messages for day', dayKey);
      }
    } else {
      // Create new note for this day
      console.log('[LinkedIn to Affinity] Creating new note for day', dayKey);

      // Only include tags and quickNote on first/earliest day
      const isFirstDay = dayKey === [...messagesByDay.keys()][0];
      const dayData = {
        ...conversationData,
        tags: isFirstDay ? conversationData.tags : [],
        quickNote: isFirstDay ? conversationData.quickNote : ''
      };

      const noteContent = formatDayConversationNote(dayData, dayKey, dayMessages);
      const note = await addNote(personId, noteContent);
      results.notesCreated++;
      results.totalNewMessages += dayMessages.length;
      console.log('[LinkedIn to Affinity] ✓ CREATED NEW NOTE for day', dayKey, '- noteId:', note.id, '- messages:', dayMessages.length);
    }
  }

  console.log('[LinkedIn to Affinity] Final result:', results.notesCreated, 'notes created,', results.notesUpdated, 'notes updated,', results.totalNewMessages, 'total messages');

  // Apply tags if provided (for existing contacts)
  const tags = conversationData.tags || [];
  if (tags.length > 0) {
    console.log('[LinkedIn to Affinity] Applying tags to existing contact:', tags);
    await populatePersonFields(personId, conversationData.sender || {}, false, tags);
  }

  // Update badge count on successful sync
  if (results.notesCreated > 0 || results.notesUpdated > 0) {
    await incrementSyncCount();
    refreshDashboardCache(); // Warm cache for next popup open
  }

  return {
    success: true,
    personId: personId,
    isNewPerson: false,
    newMessageCount: results.totalNewMessages,
    notesCreated: results.notesCreated,
    notesUpdated: results.notesUpdated
  };
}

/**
 * Create a new person and send conversation to them
 * Groups messages by day for clean organization
 */
async function createPersonAndSend(senderData, conversationData, tags = []) {
  console.log('[LinkedIn to Affinity] Creating person with sender data - name:', senderData.name,
    '| headline:', senderData.headline,
    '| company:', senderData.company,
    '| linkedinUrl:', senderData.linkedinUrl,
    '| tags:', tags);
  const person = await createPerson(senderData, tags);
  console.log('[LinkedIn to Affinity] Created new person:', person.id);

  // Group messages by day
  const messages = conversationData.messages || [];
  const messagesByDay = groupMessagesByDay(messages);

  let totalMessages = 0;
  let notesCreated = 0;
  let firstNoteId = null;

  if (messagesByDay.size === 0) {
    // No messages - create a single note with contact info
    const noteContent = formatConversationNote({ ...conversationData, tags });
    const note = await addNote(person.id, noteContent);
    firstNoteId = note.id;
    notesCreated = 1;
    console.log('[LinkedIn to Affinity] Added note:', note.id);
  } else {
    // Create a note for each day
    let isFirst = true;
    for (const [dayKey, dayMessages] of messagesByDay) {
      // Only include tags and quickNote on first day
      const dayData = {
        ...conversationData,
        tags: isFirst ? tags : [],
        quickNote: isFirst ? conversationData.quickNote : ''
      };

      const noteContent = formatDayConversationNote(dayData, dayKey, dayMessages);
      const note = await addNote(person.id, noteContent);

      if (isFirst) {
        firstNoteId = note.id;
        isFirst = false;
      }

      totalMessages += dayMessages.length;
      notesCreated++;
      console.log('[LinkedIn to Affinity] Added note for day', dayKey, ':', note.id, 'with', dayMessages.length, 'messages');
    }
  }

  // Update badge count on successful sync
  await incrementSyncCount();
  refreshDashboardCache(); // Warm cache for next popup open

  return {
    success: true,
    personId: person.id,
    noteId: firstNoteId,
    isNewPerson: true,
    personName: `${person.first_name} ${person.last_name}`.trim(),
    newMessageCount: totalMessages,
    notesCreated: notesCreated
  };
}

// ============================================================================
// Dashboard API Functions
// ============================================================================

/**
 * Fetch all lists (pipelines) from Affinity
 */
async function getLists() {
  try {
    const result = await affinityRequest('/lists');
    return result || [];
  } catch (error) {
    console.error('[LinkedIn to Affinity] Error fetching lists:', error);
    return [];
  }
}

/**
 * Add a person to a specific list
 */
async function addPersonToList(personId, listId) {
  try {
    const result = await affinityRequest(`/lists/${listId}/list-entries`, {
      method: 'POST',
      body: JSON.stringify({
        entity_id: personId,
        entity_type: 0 // 0 = person
      })
    });
    console.log('[LinkedIn to Affinity] Added person to list:', result);
    return result;
  } catch (error) {
    // Ignore "already exists" errors
    if (error.message?.includes('already exists') || error.message?.includes('duplicate')) {
      console.log('[LinkedIn to Affinity] Person already in list');
      return { already_exists: true };
    }
    throw error;
  }
}

/**
 * Get person preview data (notes, lists, last interaction)
 */
async function getPersonPreview(personId) {
  try {
    const preview = {
      noteCount: 0,
      lastNote: null,
      lists: [],
      lastInteraction: null
    };

    // Fetch notes for this person
    try {
      const notes = await affinityRequest(`/notes?person_id=${personId}`);
      if (notes && notes.length > 0) {
        preview.noteCount = notes.length;
        // Sort by created_at desc and get the most recent
        const sorted = notes.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        const latestNote = sorted[0];
        preview.lastNote = {
          preview: (latestNote.content || '').substring(0, 100) + (latestNote.content?.length > 100 ? '...' : ''),
          date: latestNote.created_at
        };
      }
    } catch (e) {
      console.log('[LinkedIn to Affinity] Could not fetch notes:', e.message);
    }

    // Fetch lists this person is on
    try {
      const listEntries = await affinityRequest(`/list-entries?person_id=${personId}`);
      if (listEntries && listEntries.length > 0) {
        const allLists = await getLists();
        const listMap = new Map(allLists.map(l => [l.id, l.name]));

        preview.lists = listEntries
          .filter(entry => listMap.has(entry.list_id))
          .map(entry => listMap.get(entry.list_id));
      }
    } catch (e) {
      console.log('[LinkedIn to Affinity] Could not fetch list entries:', e.message);
    }

    // Get interaction dates from person data
    try {
      const person = await affinityRequest(`/persons/${personId}`);
      if (person?.interaction_dates?.last_interaction_date) {
        preview.lastInteraction = person.interaction_dates.last_interaction_date;
      }
    } catch (e) {
      console.log('[LinkedIn to Affinity] Could not fetch person details:', e.message);
    }

    return preview;
  } catch (error) {
    console.error('[LinkedIn to Affinity] Error getting person preview:', error);
    return null;
  }
}

/**
 * Fetch entries for a specific list
 */
async function getListEntries(listId) {
  try {
    const result = await affinityRequest(`/lists/${listId}/list-entries`);
    return result || [];
  } catch (error) {
    console.error('[LinkedIn to Affinity] Error fetching list entries:', error);
    return [];
  }
}

/**
 * Fetch notes created since a specific date
 */
async function getRecentNotes(sinceDate) {
  try {
    const isoDate = sinceDate.toISOString();
    const result = await affinityRequest(`/notes?created_at_start=${encodeURIComponent(isoDate)}`);
    return result.notes || result || [];
  } catch (error) {
    console.error('[LinkedIn to Affinity] Error fetching recent notes:', error);
    return [];
  }
}

/**
 * Get the start of the current week (Monday)
 */
function getWeekStart() {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1); // Adjust for Sunday
  const weekStart = new Date(now.setDate(diff));
  weekStart.setHours(0, 0, 0, 0);
  return weekStart;
}

/**
 * Parse follow-up mentions from note content
 */
function parseFollowUpsFromNotes(notes) {
  const followUps = [];
  const followUpKeywords = [
    'follow up', 'follow-up', 'followup',
    'get back to', 'reach out',
    'lunch', 'coffee', 'meeting', 'call',
    'send', 'share', 'deck', 'intro'
  ];

  const datePatterns = [
    /(\d{1,2}\/\d{1,2})/g,  // MM/DD
    /(today|tomorrow|next week|monday|tuesday|wednesday|thursday|friday)/gi,
    /(\d{1,2}\s+(days?|weeks?)\s+ago)/gi
  ];

  for (const note of notes) {
    if (!note.content) continue;

    const lowerContent = note.content.toLowerCase();
    const hasFollowUp = followUpKeywords.some(kw => lowerContent.includes(kw));

    if (hasFollowUp) {
      // Try to extract person name from note
      let person = 'Unknown';
      const personMatch = note.content.match(/\*\*([^*]+)\*\*/);
      if (personMatch) {
        person = personMatch[1];
      }

      // Try to extract action
      let action = 'Follow up';
      for (const kw of followUpKeywords) {
        if (lowerContent.includes(kw)) {
          action = kw.charAt(0).toUpperCase() + kw.slice(1);
          break;
        }
      }

      // Determine if overdue (note older than 3 days without recent update)
      const noteDate = new Date(note.created_at);
      const daysSince = Math.floor((Date.now() - noteDate) / (1000 * 60 * 60 * 24));
      const overdue = daysSince > 3;

      let dueText = '';
      if (daysSince === 0) {
        dueText = 'today';
      } else if (daysSince === 1) {
        dueText = 'yesterday';
      } else {
        dueText = `${daysSince}d ago`;
      }

      followUps.push({
        person,
        action,
        dueText,
        overdue,
        noteId: note.id
      });
    }
  }

  return followUps.slice(0, 10); // Limit to 10
}

/**
 * Refresh the dashboard cache. Safe to call concurrently (deduplicates).
 */
async function refreshDashboardCache() {
  if (dashboardRefreshInProgress) {
    return dashboardDataCache;
  }

  dashboardRefreshInProgress = true;
  try {
    const freshData = await getDashboardDataFresh();
    dashboardDataCache = freshData;
    dashboardDataCacheTime = Date.now();
    console.log('[LinkedIn to Affinity] Dashboard cache refreshed');
    return freshData;
  } catch (error) {
    console.error('[LinkedIn to Affinity] Dashboard cache refresh failed:', error);
    return dashboardDataCache;
  } finally {
    dashboardRefreshInProgress = false;
  }
}

/**
 * Get dashboard data with stale-while-revalidate caching.
 * Returns: { data, isStale }
 */
async function getDashboardData() {
  const startTime = performance.now ? performance.now() : Date.now();
  const now = Date.now();
  const cacheAge = now - dashboardDataCacheTime;

  if (dashboardDataCache && cacheAge < DASHBOARD_CACHE_TTL) {
    const elapsed = (performance.now ? performance.now() : Date.now()) - startTime;
    console.log(`[LinkedIn to Affinity] Dashboard cache hit (age: ${Math.round(cacheAge / 1000)}s, ${elapsed.toFixed(1)}ms)`);
    return { data: dashboardDataCache, isStale: false };
  }

  if (dashboardDataCache) {
    const elapsed = (performance.now ? performance.now() : Date.now()) - startTime;
    console.log(`[LinkedIn to Affinity] Dashboard cache stale (age: ${Math.round(cacheAge / 1000)}s, ${elapsed.toFixed(1)}ms), refreshing in background`);
    refreshDashboardCache(); // fire-and-forget
    return { data: dashboardDataCache, isStale: true };
  }

  console.log('[LinkedIn to Affinity] Dashboard cache miss, fetching fresh data');
  const freshData = await refreshDashboardCache();
  const elapsed = (performance.now ? performance.now() : Date.now()) - startTime;
  console.log(`[LinkedIn to Affinity] Dashboard fresh fetch completed in ${elapsed.toFixed(1)}ms`);
  return { data: freshData, isStale: false };
}

/**
 * Fetch fresh dashboard data from Affinity API endpoints (uncached)
 */
async function getDashboardDataFresh() {
  const freshStartTime = performance.now ? performance.now() : Date.now();
  const weekStart = getWeekStart();

  // Fetch data in parallel
  const [lists, recentNotes, syncCountResult] = await Promise.all([
    getLists(),
    getRecentNotes(weekStart),
    browserAPI.storage.local.get(['syncCount', 'weeklyNotesCount', 'weeklyContactsCount', 'weeklyStatsWeek'])
  ]);
  const phase1Time = (performance.now ? performance.now() : Date.now()) - freshStartTime;

  // Get stored weekly stats (reset if it's a new week)
  const currentWeek = toLocalDateString(weekStart);
  let weeklyContactsCount = 0;
  let weeklyNotesCount = 0;

  if (syncCountResult.weeklyStatsWeek === currentWeek) {
    weeklyContactsCount = syncCountResult.weeklyContactsCount || 0;
    weeklyNotesCount = syncCountResult.weeklyNotesCount || 0;
  }

  // Count notes from this week (from API response)
  const notesThisWeek = recentNotes.filter(note => {
    const noteDate = new Date(note.created_at);
    return noteDate >= weekStart;
  });

  // Use the larger of stored count or API count
  weeklyNotesCount = Math.max(weeklyNotesCount, notesThisWeek.length);

  // Build weekly stats
  const weeklyStats = {
    contactsSynced: weeklyContactsCount,
    notesAdded: weeklyNotesCount,
    weekStart: currentWeek
  };

  // Build lists overview - show all lists with their entry counts
  const listsOverview = [];

  if (lists.length > 0) {
    const now = Date.now();
    const listCountsFresh = (now - listCountsCacheTime) < LIST_COUNTS_CACHE_TTL;
    let listResults;

    if (listCountsFresh && Object.keys(listCountsCache).length > 0) {
      // Use cached counts - skip all getListEntries API calls
      console.log('[LinkedIn to Affinity] Using cached list counts (age: ' +
        Math.round((now - listCountsCacheTime) / 1000) + 's)');
      listResults = lists.slice(0, 8).map(list => ({
        id: list.id,
        name: list.name,
        count: listCountsCache[list.id] ?? 0,
        type: list.type
      }));
    } else {
      // Fetch fresh counts from API (in parallel)
      const listPromises = lists.slice(0, 8).map(async (list) => {
        try {
          const entries = await getListEntries(list.id);
          return {
            id: list.id,
            name: list.name,
            count: entries?.length || 0,
            type: list.type
          };
        } catch (error) {
          console.log('[LinkedIn to Affinity] Could not fetch list entries for:', list.name);
          return {
            id: list.id,
            name: list.name,
            count: listCountsCache[list.id] ?? 0,
            type: list.type
          };
        }
      });
      listResults = await Promise.all(listPromises);

      // Update list counts cache
      const newCounts = {};
      listResults.forEach(lr => { newCounts[lr.id] = lr.count; });
      listCountsCache = newCounts;
      listCountsCacheTime = Date.now();
      console.log('[LinkedIn to Affinity] List counts cache updated');
    }

    // Sort by count (most entries first), then add to overview
    listResults
      .sort((a, b) => b.count - a.count)
      .forEach(list => {
        let icon = '📋';
        if (list.type === 0) icon = '👤';
        else if (list.type === 1) icon = '🏢';
        else if (list.type === 8) icon = '💼';

        listsOverview.push({
          id: list.id,
          name: list.name,
          count: list.count,
          icon: icon
        });
      });
  }

  // Build recent activity from notes
  const recentActivity = notesThisWeek.slice(0, 5).map(note => {
    // Extract title from note content
    let title = 'Note added';
    const urlMatch = note.content?.match(/linkedin\.com\/messaging\/thread\/[^\s]+/);
    if (urlMatch) {
      title = 'LinkedIn conversation';
    }

    // Try to get person/org name
    const nameMatch = note.content?.match(/\*\*([^*]+)\*\*/);
    if (nameMatch) {
      title = nameMatch[1];
    }

    // Calculate relative time
    const noteDate = new Date(note.created_at);
    const hoursSince = Math.floor((Date.now() - noteDate) / (1000 * 60 * 60));
    let meta = '';
    if (hoursSince < 1) {
      meta = 'just now';
    } else if (hoursSince < 24) {
      meta = `${hoursSince}h ago`;
    } else {
      const daysSince = Math.floor(hoursSince / 24);
      meta = `${daysSince}d ago`;
    }

    return {
      type: 'note',
      title,
      meta,
      noteId: note.id
    };
  });

  // Parse follow-ups from notes
  const followUps = parseFollowUpsFromNotes(notesThisWeek);

  const totalTime = (performance.now ? performance.now() : Date.now()) - freshStartTime;
  console.log(`[LinkedIn to Affinity] Dashboard fresh fetch: phase1=${phase1Time.toFixed(0)}ms, total=${totalTime.toFixed(0)}ms, lists=${lists.length}, notes=${recentNotes.length}`);

  return {
    weeklyStats,
    lists: listsOverview,
    recentActivity,
    followUps
  };
}

/**
 * Listen for messages from content script
 */
browserAPI.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[LinkedIn to Affinity] Received message:', request.action);

  if (request.action === 'sendToAffinity') {
    sendToAffinity(request.data)
      .then((result) => {
        console.log('[LinkedIn to Affinity] sendToAffinity result:', result);
        sendResponse(result);
      })
      .catch((error) => {
        console.error('[LinkedIn to Affinity] Error:', error);
        sendResponse({
          success: false,
          error: error.message || 'Unknown error'
        });
      });

    // Return true to indicate async response
    return true;
  }

  if (request.action === 'sendToAffinityWithPerson') {
    // Send to a specific person (after user selection from modal)
    sendToAffinityWithPerson(request.personId, request.conversationData, request.forceSend || false)
      .then((result) => {
        console.log('[LinkedIn to Affinity] sendToAffinityWithPerson result:', result);
        sendResponse(result);
      })
      .catch((error) => {
        console.error('[LinkedIn to Affinity] Error:', error);
        sendResponse({
          success: false,
          error: error.message || 'Unknown error'
        });
      });

    return true;
  }

  if (request.action === 'createPersonAndSend') {
    // Create new person and send (when user chooses "Create New" from modal)
    const tags = request.tags || request.conversationData?.tags || [];
    createPersonAndSend(request.senderData, request.conversationData, tags)
      .then((result) => {
        console.log('[LinkedIn to Affinity] createPersonAndSend result:', result);
        sendResponse(result);
      })
      .catch((error) => {
        console.error('[LinkedIn to Affinity] Error:', error);
        sendResponse({
          success: false,
          error: error.message || 'Unknown error'
        });
      });

    return true;
  }

  if (request.action === 'addFollowUpReminder') {
    // Add a follow-up reminder note to a person
    const reminderNote = `📅 **Follow-up Reminder**\n\nFollow up on: ${request.dateStr}\n\n_Set via LinkedIn to Affinity_`;
    addNote(request.personId, reminderNote)
      .then((result) => {
        console.log('[LinkedIn to Affinity] Follow-up reminder added:', result);
        sendResponse({ success: true, noteId: result.id });
      })
      .catch((error) => {
        console.error('[LinkedIn to Affinity] Error adding follow-up:', error);
        sendResponse({ success: false, error: error.message });
      });

    return true;
  }

  if (request.action === 'testConnection') {
    // Test API connection
    affinityRequest('/whoami')
      .then((result) => {
        console.log('[LinkedIn to Affinity] testConnection result:', result);
        sendResponse({ success: true, user: result });
      })
      .catch((error) => {
        console.error('[LinkedIn to Affinity] testConnection error:', error);
        sendResponse({ success: false, error: error.message || 'Unknown error' });
      });

    return true;
  }

  if (request.action === 'getDashboardData') {
    // Return cached dashboard data (stale-while-revalidate)
    getDashboardData()
      .then((result) => {
        console.log('[LinkedIn to Affinity] getDashboardData result, isStale:', result.isStale);
        sendResponse({ success: true, data: result.data, isStale: result.isStale });
      })
      .catch((error) => {
        console.error('[LinkedIn to Affinity] getDashboardData error:', error);
        sendResponse({ success: false, error: error.message || 'Unknown error' });
      });

    return true;
  }

  if (request.action === 'getDashboardDataFresh') {
    // Force a fresh fetch (called by popup when it received stale data)
    refreshDashboardCache()
      .then((data) => {
        sendResponse({ success: true, data, isStale: false });
      })
      .catch((error) => {
        console.error('[LinkedIn to Affinity] getDashboardDataFresh error:', error);
        sendResponse({ success: false, error: error.message || 'Unknown error' });
      });

    return true;
  }

  if (request.action === 'getLists') {
    // Fetch all lists for the dropdown
    getLists()
      .then((lists) => {
        // Filter to only person-type lists (type 0) and sort by name
        const personLists = lists
          .filter(l => l.type === 0)
          .sort((a, b) => a.name.localeCompare(b.name));
        sendResponse({ success: true, lists: personLists });
      })
      .catch((error) => {
        console.error('[LinkedIn to Affinity] getLists error:', error);
        sendResponse({ success: false, error: error.message || 'Unknown error' });
      });

    return true;
  }

  if (request.action === 'addPersonToList') {
    // Add a person to a specific list
    addPersonToList(request.personId, request.listId)
      .then((entry) => {
        console.log('[LinkedIn to Affinity] Added person to list:', entry);
        // Optimistically increment cached list count
        if (!entry.already_exists && listCountsCache[request.listId] !== undefined) {
          listCountsCache[request.listId]++;
        }
        dashboardDataCache = null;
        dashboardDataCacheTime = 0;
        sendResponse({ success: true, entry });
      })
      .catch((error) => {
        console.error('[LinkedIn to Affinity] addPersonToList error:', error);
        sendResponse({ success: false, error: error.message || 'Unknown error' });
      });

    return true;
  }

  if (request.action === 'getPersonPreview') {
    // Get person details for inline preview
    getPersonPreview(request.personId)
      .then((preview) => {
        sendResponse({ success: true, preview });
      })
      .catch((error) => {
        console.error('[LinkedIn to Affinity] getPersonPreview error:', error);
        sendResponse({ success: false, error: error.message || 'Unknown error' });
      });

    return true;
  }

  // Unknown action
  console.warn('[LinkedIn to Affinity] Unknown action:', request.action);
  return false;
});

/**
 * Handle keyboard command
 */
if (browserAPI.commands && browserAPI.commands.onCommand) {
  browserAPI.commands.onCommand.addListener((command) => {
    if (command === 'send-to-affinity') {
      // Send message to active tab's content script
      browserAPI.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          browserAPI.tabs.sendMessage(tabs[0].id, { action: 'triggerSend' });
        }
      });
    }
  });
}

console.log('[LinkedIn to Affinity] Background service worker loaded');

// Initialize badge count on load
updateBadgeCount();

// Warm dashboard cache on startup (delayed to avoid competing with other init)
setTimeout(async () => {
  try {
    const settings = await browserAPI.storage.sync.get(['affinityApiKey']);
    if (settings.affinityApiKey) {
      console.log('[LinkedIn to Affinity] Warming dashboard cache on startup');
      await refreshDashboardCache();
    }
  } catch (e) {
    console.log('[LinkedIn to Affinity] Cache warming skipped:', e.message);
  }
}, 3000);

// ============================================================================
// Follow-up Notifications
// ============================================================================

/**
 * Check for overdue follow-ups and show notifications
 */
async function checkFollowUpNotifications() {
  try {
    // Check if notifications are enabled in settings
    const settings = await browserAPI.storage.sync.get(['affinityApiKey', 'notificationsEnabled']);
    if (!settings.affinityApiKey || settings.notificationsEnabled === false) {
      return;
    }

    // Get dashboard data which includes follow-ups
    const result = await getDashboardData();
    const dashboardData = result.data;
    if (!dashboardData || !dashboardData.followUps) {
      return;
    }

    // Filter overdue follow-ups
    const overdueFollowUps = dashboardData.followUps.filter(f => f.overdue);
    if (overdueFollowUps.length === 0) {
      return;
    }

    // Check when we last showed a notification
    const lastNotified = await browserAPI.storage.local.get(['lastFollowUpNotification']);
    const now = Date.now();
    const hoursSinceLastNotification = lastNotified.lastFollowUpNotification
      ? (now - lastNotified.lastFollowUpNotification) / (1000 * 60 * 60)
      : 24;

    // Only notify if it's been at least 4 hours since last notification
    if (hoursSinceLastNotification < 4) {
      return;
    }

    // Show notification
    const count = overdueFollowUps.length;
    const firstFollowUp = overdueFollowUps[0];

    browserAPI.notifications.create('followup-reminder', {
      type: 'basic',
      iconUrl: 'icons/icon-128.png',
      title: `${count} Follow-up${count > 1 ? 's' : ''} Overdue`,
      message: count === 1
        ? `${firstFollowUp.person}: ${firstFollowUp.action}`
        : `${firstFollowUp.person} and ${count - 1} other${count > 2 ? 's' : ''} need attention`,
      priority: 1
    });

    // Update last notification time
    await browserAPI.storage.local.set({ lastFollowUpNotification: now });

    console.log('[LinkedIn to Affinity] Sent follow-up notification for', count, 'overdue items');
  } catch (error) {
    console.error('[LinkedIn to Affinity] Error checking follow-up notifications:', error);
  }
}

// Set up periodic alarm for follow-up checks
if (browserAPI.alarms) {
  // Create alarm to check every 2 hours
  browserAPI.alarms.create('followUpCheck', {
    periodInMinutes: 120
  });

  // Create alarm to warm dashboard cache every 10 minutes
  browserAPI.alarms.create('dashboardCacheWarm', {
    periodInMinutes: 10
  });

  // Handle alarms
  browserAPI.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'followUpCheck') {
      checkFollowUpNotifications();
    }
    if (alarm.name === 'dashboardCacheWarm') {
      browserAPI.storage.sync.get(['affinityApiKey'], (result) => {
        if (result.affinityApiKey) {
          refreshDashboardCache();
        }
      });
    }
  });

  // Also check on service worker startup
  setTimeout(checkFollowUpNotifications, 10000);
}

// Handle notification clicks
if (browserAPI.notifications) {
  browserAPI.notifications.onClicked.addListener((notificationId) => {
    if (notificationId === 'followup-reminder') {
      // Open the extension popup (or Affinity dashboard)
      browserAPI.action.openPopup();
    }
  });
}

// Export for testing (Node.js/Jest environment)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    formatConversationNote,
    formatDayConversationNote,
    filterNewMessages,
    normalizeMessageContent,
    parseMessageDay,
    groupMessagesByDay,
    formatDayKeyForDisplay,
    extractMessagesFromNote,
    appendMessagesToNote,
    updateNote,
    getApiKey,
    affinityRequest,
    searchPerson,
    searchOrganization,
    createOrganization,
    findOrCreateOrganization,
    fetchLinkedInProfile,
    parseLinkedInProfileHtml,
    parseHeadlineForProfile,
    findPersonFields,
    populatePersonFields,
    findDropdownOption,
    resetCaches,
    createPerson,
    addNote,
    getNotesForPerson,
    checkDuplicateAndGetExistingMessages,
    sendToAffinity,
    sendToAffinityWithPerson,
    createPersonAndSend,
    getDashboardData,
    getDashboardDataFresh,
    refreshDashboardCache
  };
}
