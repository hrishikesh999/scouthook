'use strict';

/**
 * testLinkedInPost.js — PRD Session 4, step 1
 *
 * Confirms the raw LinkedIn UGC Posts API accepts calls before any OAuth
 * or UI is built. Run this first. Do not proceed until it posts successfully.
 *
 * Usage:
 *   TEST_TOKEN="your_access_token" TEST_PERSON_URN="urn:li:person:XXXXX" node scripts/testLinkedInPost.js
 *
 * How to get a test token:
 *   1. Go to developer.linkedin.com → your app → OAuth 2.0 Tools
 *   2. Generate an access token with the w_member_social scope
 *   3. Copy the token value
 *
 * How to get your person URN:
 *   curl -H "Authorization: Bearer YOUR_TOKEN" https://api.linkedin.com/v2/me
 *   The "id" field in the response is your person ID → urn:li:person:{id}
 */

const TEST_TOKEN      = process.env.TEST_TOKEN;
const TEST_PERSON_URN = process.env.TEST_PERSON_URN;

if (!TEST_TOKEN || !TEST_PERSON_URN) {
  console.error('Usage: TEST_TOKEN="..." TEST_PERSON_URN="urn:li:person:..." node scripts/testLinkedInPost.js');
  process.exit(1);
}

const POST_CONTENT = `Scouthook test post — ${new Date().toISOString()}

This is a test post from the Scouthook API integration script.
If you can see this, the LinkedIn API connection is working correctly.

(Feel free to delete this post.)`;

async function run() {
  console.log('[test] Posting to LinkedIn as', TEST_PERSON_URN);

  const body = {
    author: TEST_PERSON_URN,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text: POST_CONTENT },
        shareMediaCategory: 'NONE',
      },
    },
    visibility: {
      'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
    },
  };

  const res = await fetch('https://api.linkedin.com/v2/ugcPosts', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TEST_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
      'LinkedIn-Version': '202308',
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();

  if (!res.ok) {
    console.error('[test] FAILED — HTTP', res.status);
    console.error('[test] Response:', text);
    process.exit(1);
  }

  let data;
  try { data = JSON.parse(text); } catch { data = text; }

  console.log('[test] SUCCESS — post created');
  console.log('[test] LinkedIn post ID:', data.id || data);
  console.log('[test] ✓ LinkedIn API is working. Proceed with Session 4 build.');
}

run().catch(err => {
  console.error('[test] Unexpected error:', err.message);
  process.exit(1);
});
