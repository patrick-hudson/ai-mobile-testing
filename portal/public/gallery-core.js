export const GALLERY_KEYS = Object.freeze({
  previousItem: 'ArrowLeft',
  nextItem: 'ArrowRight',
  previousTest: 'ArrowUp',
  nextTest: 'ArrowDown',
  previousMember: '[',
  nextMember: ']',
  playPause: ' ',
  context: 'i',
  fullscreen: 'f',
  escape: 'Escape',
  help: '?',
});

export const GALLERY_LIMITS = Object.freeze({
  pageRows: 100,
  filmstripItems: 9,
  queueItems: 60,
  overviewItems: 64,
  galleryDomNodes: 500,
  retainedDetails: 1,
  retainedSelectedVideos: 1,
  retainedThumbnails: 72,
  retainedPlayback: 25,
  facetOptions: 20,
  announcementCharacters: 320,
});

const MEDIA_KINDS = new Set(['image', 'video']);
const MEMBER_ROLES = new Set(['single', 'baseline', 'actual', 'diff', 'other', 'unknown']);
const FLAG_STATES = new Set(['open', 'resolved', 'dismissed', 'unflagged']);
const REQUEST_SLOTS = ['head', 'query', 'detail', 'availability', 'media', 'thumbnail', 'flag'];
const EMPTY_QUERY = Object.freeze({
  kinds: [],
  statuses: [],
  environments: [],
  featureSuites: [],
  technicalSuites: [],
  targets: [],
  flagStates: [],
  search: '',
  group: 'feature',
  sort: 'attention',
});

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object.`);
  return value;
}

function safeText(value, name, maximum = 1_200, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && value.trim() === '')) {
    throw new TypeError(`${name} is invalid.`);
  }
  return value;
}

function safeStrings(value, name, maximumEntries = 100, maximumLength = 1_200) {
  if (!Array.isArray(value) || value.length > maximumEntries) throw new TypeError(`${name} is invalid.`);
  return value.map((entry) => safeText(entry, name, maximumLength, true));
}

function safeOrdinal(value, name, nullable = false) {
  if (nullable && value === null) return null;
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${name} is invalid.`);
  return value;
}

function cloneAssociation(value) {
  const association = requireObject(value, 'Gallery audit association');
  return Object.freeze({
    id: safeText(association.id, 'Gallery audit ID', 160),
    title: safeText(association.title, 'Gallery audit title'),
    catalogOrdinal: safeOrdinal(association.catalogOrdinal, 'Gallery audit ordinal', true),
  });
}

export function decodeGalleryQueryRow(value) {
  const row = requireObject(value, 'Gallery query row');
  if (!/^gitem_[a-f0-9]{16}$/.test(row.id ?? '')) throw new TypeError('Gallery query row item ID is invalid.');
  if (!/^gtest_[a-f0-9]{16}$/.test(row.testGroupId ?? '')) throw new TypeError('Gallery query row test-group ID is invalid.');
  if (!MEDIA_KINDS.has(row.kind)) throw new TypeError('Gallery query row media kind is invalid.');
  if (!FLAG_STATES.has(row.flagState)) throw new TypeError('Gallery query row flag state is invalid.');
  const attempt = requireObject(row.attempt, 'Gallery query row attempt');
  const attemptOrdinal = safeOrdinal(attempt.ordinal, 'Gallery attempt ordinal');
  if (attemptOrdinal < 1) throw new TypeError('Gallery attempt ordinal is invalid.');
  const captureTime = row.captureTime === null ? null : safeText(row.captureTime, 'Gallery capture time', 100);
  if (captureTime !== null && Number.isNaN(Date.parse(captureTime))) throw new TypeError('Gallery capture time is invalid.');
  const primaryFeatureSuite = row.primaryFeatureSuite === null
    ? null
    : safeText(row.primaryFeatureSuite, 'Gallery primary feature suite');
  return Object.freeze({
    id: row.id,
    testGroupId: row.testGroupId,
    kind: row.kind,
    title: safeText(row.title, 'Gallery test title'),
    testLabel: safeText(row.testLabel, 'Gallery test label'),
    testTitlePath: Object.freeze(safeStrings(row.testTitlePath, 'Gallery title path', 50)),
    projectName: safeText(row.projectName, 'Gallery project name', 300),
    status: safeText(row.status, 'Gallery status', 120),
    environment: safeText(row.environment, 'Gallery environment', 120),
    featureSuites: Object.freeze(safeStrings(row.featureSuites, 'Gallery feature suites')),
    primaryFeatureSuite,
    primaryAuditCatalogOrdinal: safeOrdinal(row.primaryAuditCatalogOrdinal, 'Gallery primary audit ordinal', true),
    technicalSuite: safeText(row.technicalSuite, 'Gallery technical suite', 1_200, true),
    targets: Object.freeze(safeStrings(row.targets, 'Gallery targets')),
    flagState: row.flagState,
    attempt: Object.freeze({ ordinal: attemptOrdinal, retry: safeOrdinal(attempt.retry, 'Gallery retry') }),
    captureTime,
    available: (() => {
      if (typeof row.available !== 'boolean') throw new TypeError('Gallery query row availability is invalid.');
      return row.available;
    })(),
    visualWarning: (() => {
      if (typeof row.visualWarning !== 'boolean') throw new TypeError('Gallery query row visual warning is invalid.');
      return row.visualWarning;
    })(),
    auditAssociations: Object.freeze((Array.isArray(row.auditAssociations) ? row.auditAssociations : []).map(cloneAssociation)),
  });
}

function cloneMember(value) {
  const member = requireObject(value, 'Gallery media member');
  if (!MEMBER_ROLES.has(member.role)) throw new TypeError('Gallery media member role is invalid.');
  return Object.freeze({
    id: safeText(member.id, 'Gallery member ID', 160),
    name: safeText(member.name, 'Gallery member name'),
    role: member.role,
    contentType: safeText(member.contentType, 'Gallery member content type', 200),
    available: (() => {
      if (typeof member.available !== 'boolean') throw new TypeError('Gallery member availability is invalid.');
      return member.available;
    })(),
    error: member.error === null ? null : safeText(member.error, 'Gallery member error', 4_000, true),
    adapterPosterReference: Object.freeze({
      href: typeof member.poster?.href === 'string' ? member.poster.href : null,
    }),
  });
}

export function decodeGalleryItemDetail(value) {
  const detail = requireObject(value, 'Gallery item detail');
  if (detail.schemaVersion !== 1) throw new TypeError('Gallery item detail schema is unsupported.');
  const item = requireObject(detail.item, 'Gallery item');
  if (!/^gitem_[a-f0-9]{16}$/.test(item.id ?? '') || !MEDIA_KINDS.has(item.kind)) {
    throw new TypeError('Gallery item identity is invalid.');
  }
  const test = requireObject(item.test, 'Gallery item test');
  const attempt = requireObject(item.attempt, 'Gallery item attempt');
  const project = requireObject(item.project, 'Gallery item project');
  const capture = requireObject(item.capture, 'Gallery capture context');
  const members = (Array.isArray(item.members) ? item.members : []).map(cloneMember);
  if (members.length < 1 || members.length > 20) throw new TypeError('Gallery item member count is invalid.');
  const media = (Array.isArray(detail.media) ? detail.media : []).map((entry) => {
    const source = requireObject(entry, 'Gallery media projection');
    const memberId = safeText(source.memberId, 'Gallery media projection member ID', 160);
    if (!members.some((member) => member.id === memberId)) throw new TypeError('Gallery media projection member is invalid.');
    return Object.freeze({
      memberId,
      contentType: safeText(source.contentType, 'Gallery media content type', 200),
      available: (() => {
        if (typeof source.available !== 'boolean') throw new TypeError('Gallery media projection availability is invalid.');
        return source.available;
      })(),
      // This opaque reference is passed back only to the adapter. The core never
      // copies it to a URL-bearing DOM property.
      adapterReference: Object.freeze({ href: typeof source.href === 'string' ? source.href : null }),
      adapterPosterReference: Object.freeze({
        href: typeof source.poster?.href === 'string'
          ? source.poster.href
          : members.find((member) => member.id === memberId)?.adapterPosterReference?.href ?? null,
      }),
    });
  });
  if (media.length !== members.length) throw new TypeError('Gallery media projection count is invalid.');
  const availability = requireObject(detail.availability, 'Gallery item availability');
  if (!['available', 'tombstone'].includes(availability.state) || typeof availability.retryable !== 'boolean') {
    throw new TypeError('Gallery item availability is invalid.');
  }
  return Object.freeze({
    schemaVersion: 1,
    item: Object.freeze({
      id: item.id,
      kind: item.kind,
      test: Object.freeze({
        id: safeText(test.id, 'Gallery test ID', 500),
        title: safeText(test.title, 'Gallery test title'),
        titlePath: Object.freeze(safeStrings(test.titlePath, 'Gallery item title path', 50)),
        file: safeText(test.file, 'Gallery test file', 1_200, true),
        technicalSuite: safeText(test.technicalSuite, 'Gallery technical suite', 1_200, true),
      }),
      attempt: Object.freeze({
        ordinal: safeOrdinal(attempt.ordinal, 'Gallery attempt ordinal'),
        retry: safeOrdinal(attempt.retry, 'Gallery retry'),
        status: safeText(attempt.status, 'Gallery attempt status', 120),
        rawStatus: attempt.rawStatus == null
          ? safeText(attempt.status, 'Gallery raw attempt status', 120)
          : safeText(attempt.rawStatus, 'Gallery raw attempt status', 120),
        statusSource: attempt.statusSource == null
          ? 'raw-live'
          : safeText(attempt.statusSource, 'Gallery status source', 120),
        reviewReasonCodes: Object.freeze(safeStrings(attempt.reviewReasonCodes ?? [], 'Gallery review reason codes', 12, 120)),
        expectedStatus: attempt.expectedStatus === null ? null : safeText(attempt.expectedStatus, 'Gallery expected status', 120),
        startedAt: attempt.startedAt === null ? null : safeText(attempt.startedAt, 'Gallery start time', 100),
        durationMs: Number.isFinite(attempt.durationMs) && attempt.durationMs >= 0 ? attempt.durationMs : 0,
      }),
      project: Object.freeze({
        name: safeText(project.name, 'Gallery project name', 300),
        environment: safeText(project.environment, 'Gallery environment', 120),
        browser: safeText(project.browser, 'Gallery browser', 300),
        deviceClass: safeText(project.deviceClass, 'Gallery device class', 120),
      }),
      auditAssociations: Object.freeze((Array.isArray(item.auditAssociations) ? item.auditAssociations : []).map((association) => {
        const base = cloneAssociation(association);
        return Object.freeze({
          ...base,
          expected: safeText(association.expected, 'Gallery expected behavior', 4_000),
          featureSuite: safeText(association.featureSuite, 'Gallery feature suite'),
        });
      })),
      members: Object.freeze(members),
      comparison: item.comparison && typeof item.comparison === 'object'
        ? Object.freeze({ key: safeText(item.comparison.key, 'Gallery comparison key'), complete: Boolean(item.comparison.complete) })
        : null,
      capture: Object.freeze({
        route: capture.route === null ? null : safeText(capture.route, 'Gallery route', 2_000, true),
        observedState: capture.observedState === null ? null : safeText(capture.observedState, 'Gallery observed state', 4_000, true),
        rationale: capture.rationale === null ? null : safeText(capture.rationale, 'Gallery capture rationale', 4_000, true),
        capturedAt: capture.capturedAt === null ? null : safeText(capture.capturedAt, 'Gallery capture time', 100),
        viewport: capture.viewport && Number.isInteger(capture.viewport.width) && Number.isInteger(capture.viewport.height)
          ? Object.freeze({ width: capture.viewport.width, height: capture.viewport.height })
          : null,
      }),
    }),
    media: Object.freeze(media),
    availability: Object.freeze({
      state: availability.state,
      retryable: availability.retryable,
      message: availability.message === null ? null : safeText(availability.message, 'Gallery availability message', 4_000, true),
    }),
    review: detail.review && typeof detail.review === 'object' ? Object.freeze({
      flagRevision: typeof detail.review.flagRevision === 'string' ? detail.review.flagRevision : null,
      flags: Object.freeze((Array.isArray(detail.review.flags) ? detail.review.flags : []).slice(0, 100).map((value) => {
        const flag = requireObject(value, 'Gallery reviewer flag');
        return Object.freeze({
          flagId: typeof flag.flagId === 'string' ? safeText(flag.flagId, 'Gallery flag ID', 160) : null,
          state: typeof flag.state === 'string' && ['open', 'resolved', 'dismissed'].includes(flag.state) ? flag.state : 'open',
          reviewer: typeof flag.reviewer === 'string' ? safeText(flag.reviewer, 'Gallery reviewer', 120, true) : '',
          note: flag.note === null || flag.note === undefined ? null : safeText(flag.note, 'Gallery flag note', 4_000, true),
          justification: flag.justification === null || flag.justification === undefined
            ? null
            : safeText(flag.justification, 'Gallery flag justification', 4_000, true),
        });
      })),
    }) : Object.freeze({ flagRevision: null, flags: [] }),
  });
}

function normalizedQuery(value = EMPTY_QUERY) {
  const source = value && typeof value === 'object' ? value : {};
  const list = (name) => [...new Set((Array.isArray(source[name]) ? source[name] : [])
    .filter((entry) => typeof entry === 'string' && entry.trim())
    .map((entry) => entry.trim()))].sort();
  return Object.freeze({
    kinds: Object.freeze(list('kinds').filter((kind) => MEDIA_KINDS.has(kind))),
    statuses: Object.freeze(list('statuses')),
    environments: Object.freeze(list('environments')),
    featureSuites: Object.freeze(list('featureSuites')),
    technicalSuites: Object.freeze(list('technicalSuites')),
    targets: Object.freeze(list('targets')),
    flagStates: Object.freeze(list('flagStates').filter((state) => FLAG_STATES.has(state))),
    search: typeof source.search === 'string' ? source.search.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 1_200) : '',
    group: ['feature', 'technical', 'none'].includes(source.group) ? source.group : 'feature',
    sort: ['attention', 'feature', 'technical', 'audit', 'capture-time'].includes(source.sort) ? source.sort : 'attention',
  });
}

function queryKey(query) {
  return JSON.stringify(normalizedQuery(query));
}

function defaultRequests() {
  return Object.fromEntries(REQUEST_SLOTS.map((slot) => [slot, {
    generation: 0,
    semanticKey: null,
    status: 'idle',
    error: null,
  }]));
}

export function createInitialGalleryState(overrides = {}) {
  const query = normalizedQuery(overrides.query);
  return {
    mode: overrides.mode === 'overview' ? 'overview' : 'workbench',
    phase: 'loading',
    descriptor: null,
    query,
    suiteAnchor: null,
    accepted: {
      contentRevision: null,
      flagRevision: null,
      orderRevision: null,
      items: [],
      total: 0,
      windows: [],
      nextCursor: null,
    },
    pendingRevision: null,
    selection: {
      itemId: null,
      memberId: null,
      outOfFilterAnchor: null,
    },
    detail: null,
    availability: null,
    media: { status: 'idle', itemId: null, memberId: null, source: null, error: null },
    thumbnails: {},
    playback: {},
    layers: {
      fullscreen: false,
      help: false,
      context: true,
      responsivePanel: null,
      focusHistory: [],
    },
    history: [],
    capability: { flagsMutable: false },
    requests: defaultRequests(),
    purged: false,
    ...(overrides.phase ? { phase: overrides.phase } : {}),
  };
}

function requestMatches(state, action) {
  const request = state.requests[action.slot];
  if (!request || request.generation !== action.generation || request.semanticKey !== action.semanticKey) return false;
  if (
    action.contentRevision
    && action.contentRevision !== (state.accepted.contentRevision ?? action.contentRevision)
    && !(action.slot === 'query' && action.acceptPending && state.pendingRevision?.applying)
  ) return false;
  if (['detail', 'availability', 'media', 'flag'].includes(action.slot) && action.itemId && action.itemId !== state.selection.itemId) return false;
  if (action.slot === 'media' && action.memberId && action.memberId !== state.selection.memberId) return false;
  return true;
}

function updateRequest(state, slot, value) {
  return { ...state, requests: { ...state.requests, [slot]: { ...state.requests[slot], ...value } } };
}

function nearestVisibleItem(previousItems, nextItems, previousId) {
  if (nextItems.length === 0) return null;
  const previousIndex = Math.max(0, previousItems.findIndex(({ id }) => id === previousId));
  const previousPositions = new Map(previousItems.map((item, index) => [item.id, index]));
  return [...nextItems].sort((left, right) => {
    const leftDistance = Math.abs((previousPositions.get(left.id) ?? previousIndex) - previousIndex);
    const rightDistance = Math.abs((previousPositions.get(right.id) ?? previousIndex) - previousIndex);
    return leftDistance - rightDistance || left.id.localeCompare(right.id);
  })[0]?.id ?? nextItems[0].id;
}

function preferredMember(detail, existingId = null) {
  const members = detail?.item?.members ?? [];
  if (members.some(({ id }) => id === existingId)) return existingId;
  return members.find(({ role, available }) => role === 'actual' && available)?.id
    ?? members.find(({ available }) => available)?.id
    ?? members[0]?.id
    ?? null;
}

function withSelection(state, itemId, options = {}) {
  if (itemId === state.selection.itemId && !options.forceHistory) return state;
  const history = options.history === false || state.selection.itemId === null
    ? state.history
    : [...state.history, {
        mode: state.mode,
        itemId: options.historyItemId ?? state.selection.itemId,
        focusKey: options.historyFocusKey ?? null,
      }].slice(-50);
  if (itemId === state.selection.itemId) return { ...state, history };
  const selected = state.accepted.items.find(({ id }) => id === itemId);
  const suiteAnchor = selected
    ? state.query.group === 'technical' ? selected.technicalSuite : selected.primaryFeatureSuite
    : state.suiteAnchor;
  return {
    ...state,
    history,
    suiteAnchor,
    selection: { ...state.selection, itemId, memberId: null },
    detail: null,
    availability: null,
    media: { status: 'idle', itemId, memberId: null, source: null, error: null },
  };
}

export function galleryReducer(state, action) {
  switch (action.type) {
    case 'REQUEST_STARTED': {
      if (!REQUEST_SLOTS.includes(action.slot)) return state;
      return updateRequest(state, action.slot, {
        generation: action.generation,
        semanticKey: action.semanticKey,
        status: 'loading',
        error: null,
      });
    }
    case 'REQUEST_CANCELLED':
      return requestMatches(state, action) ? updateRequest(state, action.slot, { status: 'idle' }) : state;
    case 'REQUEST_FAILED': {
      if (!requestMatches(state, action)) return state;
      let next = updateRequest(state, action.slot, { status: 'error', error: String(action.error ?? 'Request failed.') });
      if (action.slot === 'query' && next.pendingRevision?.applying) {
        next = { ...next, pendingRevision: { ...next.pendingRevision, applying: false } };
      }
      return action.slot === 'media'
        ? { ...next, media: { ...next.media, status: 'error', source: null, error: String(action.error ?? 'Media unavailable.') } }
        : next;
    }
    case 'HEAD_SUCCEEDED': {
      if (!requestMatches(state, action)) return state;
      const head = requireObject(action.head, 'Gallery descriptor');
      if (typeof head.contentRevision !== 'string' || typeof head.orderRevision !== 'string') throw new TypeError('Gallery descriptor revision is invalid.');
      if (state.accepted.contentRevision && (
        head.contentRevision !== state.accepted.contentRevision
        || head.orderRevision !== state.accepted.orderRevision
        || (head.flagRevision ?? null) !== state.accepted.flagRevision
      )) {
        return {
          ...updateRequest(state, 'head', { status: 'success' }),
          pendingRevision: {
            contentRevision: head.contentRevision,
            flagRevision: head.flagRevision ?? null,
            orderRevision: head.orderRevision,
            head,
            attentionCount: Number.isInteger(action.attentionCount) ? action.attentionCount : 0,
          },
        };
      }
      return {
        ...updateRequest(state, 'head', { status: 'success' }),
        descriptor: head,
        phase: ['waiting', 'live', 'sealed'].includes(head.phase) ? head.phase : state.phase,
      };
    }
    case 'REVISION_AVAILABLE': {
      if (
        action.contentRevision === state.accepted.contentRevision
        && action.orderRevision === state.accepted.orderRevision
        && (action.flagRevision ?? null) === state.accepted.flagRevision
      ) return state;
      const samePendingRevision = state.pendingRevision
        && action.contentRevision === state.pendingRevision.contentRevision
        && action.orderRevision === state.pendingRevision.orderRevision
        && (action.flagRevision ?? null) === state.pendingRevision.flagRevision;
      if (samePendingRevision) {
        return {
          ...state,
          pendingRevision: {
            ...state.pendingRevision,
            head: action.head ?? state.pendingRevision.head,
            attentionCount: Number.isInteger(action.attentionCount)
              ? action.attentionCount
              : state.pendingRevision.attentionCount,
          },
        };
      }
      return {
        ...state,
        pendingRevision: {
          contentRevision: action.contentRevision,
          flagRevision: action.flagRevision ?? null,
          orderRevision: action.orderRevision,
          head: action.head ?? null,
          attentionCount: Number.isInteger(action.attentionCount) ? action.attentionCount : 0,
        },
      };
    }
    case 'APPLY_PENDING_REVISION':
      return state.pendingRevision ? {
        ...state,
        pendingRevision: { ...state.pendingRevision, applying: true },
      } : state;
    case 'SET_QUERY':
      return { ...state, query: normalizedQuery(action.query), suiteAnchor: action.suiteAnchor ?? state.suiteAnchor };
    case 'QUERY_SUCCEEDED': {
      if (!requestMatches(state, action)) return state;
      if (action.acceptPending && (
        !state.pendingRevision?.applying
        || action.contentRevision !== state.pendingRevision.contentRevision
        || action.orderRevision !== state.pendingRevision.orderRevision
        || (action.flagRevision ?? null) !== state.pendingRevision.flagRevision
      )) return state;
      const rows = (Array.isArray(action.rows) ? action.rows : []).map(decodeGalleryQueryRow);
      const merged = action.append
        ? [...state.accepted.items, ...rows.filter((row) => !state.accepted.items.some(({ id }) => id === row.id))]
        : rows;
      const revision = action.contentRevision ?? state.accepted.contentRevision;
      const revisionChanged = revision !== state.accepted.contentRevision
        || (action.orderRevision ?? state.accepted.orderRevision) !== state.accepted.orderRevision
        || (action.flagRevision ?? state.accepted.flagRevision) !== state.accepted.flagRevision;
      let itemId = state.selection.itemId;
      let anchor = state.selection.outOfFilterAnchor;
      if (anchor && merged.some(({ id }) => id === anchor) && action.restoreAnchor !== false) {
        itemId = anchor;
        anchor = null;
      } else if (itemId && !merged.some(({ id }) => id === itemId)) {
        anchor = anchor ?? itemId;
        itemId = nearestVisibleItem(state.accepted.items, merged, itemId);
      } else if (!itemId) {
        itemId = merged.some(({ id }) => id === action.preferredItemId)
          ? action.preferredItemId
          : merged[0]?.id ?? null;
      }
      const selectionChanged = itemId !== state.selection.itemId;
      const selectedRow = merged.find(({ id }) => id === itemId);
      const suiteAnchor = selectedRow
        ? action.queryGroup === 'technical' || state.query.group === 'technical'
          ? selectedRow.technicalSuite
          : selectedRow.primaryFeatureSuite
        : state.suiteAnchor;
      return {
        ...updateRequest(state, 'query', { status: 'success' }),
        descriptor: action.acceptPending ? state.pendingRevision?.head ?? state.descriptor : state.descriptor,
        phase: action.phase ?? state.phase,
        accepted: {
          contentRevision: revision,
          flagRevision: action.flagRevision ?? state.accepted.flagRevision,
          orderRevision: action.orderRevision ?? state.accepted.orderRevision,
          items: merged,
          total: Number.isInteger(action.total) ? action.total : merged.length,
          windows: action.append
            ? [...state.accepted.windows, { offset: action.offset ?? state.accepted.items.length, ids: rows.map(({ id }) => id) }]
            : [{ offset: action.offset ?? 0, ids: rows.map(({ id }) => id) }],
          nextCursor: action.nextCursor ?? null,
        },
        selection: { itemId, memberId: selectionChanged ? null : state.selection.memberId, outOfFilterAnchor: anchor },
        suiteAnchor,
        detail: selectionChanged || revisionChanged ? null : state.detail,
        availability: selectionChanged || revisionChanged ? null : state.availability,
        thumbnails: revisionChanged ? {} : state.thumbnails,
        media: selectionChanged || revisionChanged
          ? { status: 'idle', itemId, memberId: null, source: null, error: null }
          : state.media,
        pendingRevision: action.acceptPending ? null : state.pendingRevision,
      };
    }
    case 'SELECT_ITEM': {
      if (!state.accepted.items.some(({ id }) => id === action.itemId)) return state;
      return withSelection(state, action.itemId, action);
    }
    case 'DETAIL_SUCCEEDED': {
      if (!requestMatches(state, action)) return state;
      const detail = decodeGalleryItemDetail(action.detail);
      if (detail.item.id !== state.selection.itemId) return state;
      const memberId = preferredMember(detail, state.selection.memberId);
      return {
        ...updateRequest(state, 'detail', { status: 'success' }),
        detail,
        availability: detail.availability,
        selection: { ...state.selection, memberId },
        media: { status: 'idle', itemId: detail.item.id, memberId, source: null, error: null },
      };
    }
    case 'AVAILABILITY_SUCCEEDED':
      return requestMatches(state, action)
        ? { ...updateRequest(state, 'availability', { status: 'success' }), availability: action.availability }
        : state;
    case 'SET_MEMBER': {
      if (!state.detail) return state;
      const members = state.detail.item.members;
      const target = typeof action.memberId === 'string'
        ? members.find(({ id }) => id === action.memberId)
        : members[Math.max(0, Math.min(members.length - 1, members.findIndex(({ id }) => id === state.selection.memberId) + action.delta))];
      if (!target || target.id === state.selection.memberId) return state;
      return {
        ...state,
        selection: { ...state.selection, memberId: target.id },
        media: { status: 'idle', itemId: state.selection.itemId, memberId: target.id, source: null, error: null },
      };
    }
    case 'MEDIA_SUCCEEDED': {
      if (!requestMatches(state, action)) return state;
      const source = trustedResolvedMedia(action.source);
      if (!source) return galleryReducer(state, { ...action, type: 'REQUEST_FAILED', error: 'The media adapter returned an unsafe source.' });
      return {
        ...updateRequest(state, 'media', { status: 'success' }),
        media: { status: 'resolved', itemId: action.itemId, memberId: action.memberId, source, error: null, posterError: null },
      };
    }
    case 'MEDIA_ELEMENT_LOADED':
      return action.itemId === state.selection.itemId && action.memberId === state.selection.memberId && state.media.status !== 'ready'
        ? { ...state, media: { ...state.media, status: 'ready', error: null } }
        : state;
    case 'POSTER_ELEMENT_FAILED':
      return action.itemId === state.selection.itemId && action.memberId === state.selection.memberId && state.media.source?.posterUrl
        ? { ...state, media: {
            ...state.media,
            source: state.media.source ? { ...state.media.source, posterUrl: null } : null,
            posterError: 'The video poster could not be loaded; video playback remains available.',
          } }
        : state;
    case 'MEDIA_ELEMENT_FAILED':
      return action.itemId === state.selection.itemId && action.memberId === state.selection.memberId ? {
        ...state,
        media: {
          status: 'error', itemId: action.itemId, memberId: action.memberId,
          source: null, error: String(action.error ?? 'The selected media could not be loaded.'),
        },
        availability: {
          state: 'tombstone', retryable: true,
          message: String(action.error ?? 'The selected media could not be loaded.'),
        },
      } : state;
    case 'THUMBNAIL_SUCCEEDED': {
      if (!requestMatches(state, action)) return state;
      const source = trustedResolvedMedia(action.source);
      if (!source) return state;
      return {
        ...updateRequest(state, 'thumbnail', { status: 'success' }),
        thumbnails: Object.fromEntries(Object.entries({ ...state.thumbnails, [action.itemId]: source.url }).slice(-GALLERY_LIMITS.retainedThumbnails)),
      };
    }
    case 'SET_PLAYBACK':
      return action.memberId ? {
        ...state,
        playback: Object.fromEntries(Object.entries({
          ...state.playback,
          [action.memberId]: { time: Math.max(0, Number(action.time) || 0), paused: action.paused !== false },
        }).slice(-GALLERY_LIMITS.retainedPlayback)),
      } : state;
    case 'SET_MODE':
      return ['workbench', 'overview'].includes(action.mode) ? { ...state, mode: action.mode } : state;
    case 'SET_SUITE_ANCHOR':
      return { ...state, suiteAnchor: action.suiteAnchor ?? null };
    case 'OPEN_LAYER': {
      const key = action.focusKey ?? null;
      const focusHistory = key ? [...state.layers.focusHistory, key].slice(-20) : state.layers.focusHistory;
      if (action.layer === 'help') return { ...state, layers: { ...state.layers, help: true, focusHistory } };
      if (action.layer === 'context') return { ...state, layers: { ...state.layers, context: true, focusHistory } };
      if (action.layer === 'responsivePanel') return { ...state, layers: { ...state.layers, responsivePanel: action.panel ?? 'queue', focusHistory } };
      return state;
    }
    case 'CLOSE_LAYER': {
      const focusHistory = state.layers.focusHistory.slice(0, -1);
      if (action.layer === 'help') return { ...state, layers: { ...state.layers, help: false, focusHistory } };
      if (action.layer === 'context') return { ...state, layers: { ...state.layers, context: false, focusHistory } };
      if (action.layer === 'responsivePanel') return { ...state, layers: { ...state.layers, responsivePanel: null, focusHistory } };
      return state;
    }
    case 'FULLSCREEN_CHANGED':
      return { ...state, layers: { ...state.layers, fullscreen: Boolean(action.active) } };
    case 'ESCAPE_LAYER': {
      if (state.layers.fullscreen) return { ...state, layers: { ...state.layers, fullscreen: false } };
      if (state.layers.help) return galleryReducer(state, { type: 'CLOSE_LAYER', layer: 'help' });
      if (state.layers.responsivePanel) return galleryReducer(state, { type: 'CLOSE_LAYER', layer: 'responsivePanel' });
      if (state.layers.context) return galleryReducer(state, { type: 'CLOSE_LAYER', layer: 'context' });
      if (state.mode === 'overview') return { ...state, mode: 'workbench' };
      if (state.history.length > 0) {
        const previous = state.history.at(-1);
        return {
          ...withSelection({ ...state, mode: previous.mode, history: state.history.slice(0, -1) }, previous.itemId, { history: false }),
          history: state.history.slice(0, -1),
        };
      }
      return state;
    }
    case 'SET_CAPABILITY':
      return { ...state, capability: { ...state.capability, ...action.capability } };
    case 'FLAG_SUCCEEDED':
      return requestMatches(state, action)
        ? { ...updateRequest(state, 'flag', { status: 'success' }), pendingRevision: action.pendingRevision ?? state.pendingRevision }
        : state;
    case 'PURGED':
      return { ...state, purged: true, phase: 'purged', capability: { ...state.capability, flagsMutable: false } };
    default:
      return state;
  }
}

export function selectSelectedRow(state) {
  return state.accepted.items.find(({ id }) => id === state.selection.itemId) ?? null;
}

export function selectSelectedMember(state) {
  return state.detail?.item?.members.find(({ id }) => id === state.selection.memberId) ?? null;
}

export function selectSequencePosition(state) {
  const index = state.accepted.items.findIndex(({ id }) => id === state.selection.itemId);
  return { index, ordinal: index < 0 ? 0 : index + 1, total: state.accepted.total };
}

export function selectLocalFilmstrip(state) {
  const index = state.accepted.items.findIndex(({ id }) => id === state.selection.itemId);
  if (index < 0) return [];
  const radius = Math.floor(GALLERY_LIMITS.filmstripItems / 2);
  const start = Math.max(0, Math.min(index - radius, state.accepted.items.length - GALLERY_LIMITS.filmstripItems));
  return state.accepted.items.slice(start, start + GALLERY_LIMITS.filmstripItems);
}

export function selectAsyncState(state) {
  if (state.purged) return { key: 'purged-run', title: 'This run was purged', recovery: 'Return to runs' };
  if (state.requests.head.status === 'error' && !state.accepted.contentRevision) {
    return { key: 'terminal-catalog-error', title: 'The visual evidence index could not be loaded', recovery: 'Retry from a fresh descriptor' };
  }
  if (state.requests.query.status === 'error' && !state.accepted.contentRevision && state.accepted.items.length === 0) {
    return { key: 'terminal-catalog-error', title: 'The visual evidence index could not be loaded', recovery: 'Retry from a fresh descriptor' };
  }
  if (['waiting', 'live'].includes(state.phase) && state.accepted.total === 0 && state.requests.query.status !== 'loading') {
    return { key: 'active-run-waiting', title: 'Waiting for finalized visual evidence', recovery: 'Continue watching' };
  }
  if (state.phase === 'sealed' && (state.descriptor?.primaryCounts?.total ?? state.accepted.total) === 0) {
    return { key: 'sealed-empty', title: 'This run has no eligible visual evidence', recovery: 'Inspect test outcomes or raw files' };
  }
  if ((state.descriptor?.primaryCounts?.total ?? 0) > 0 && state.accepted.total === 0 && state.requests.query.status !== 'loading') {
    return { key: 'zero-filtered-results', title: 'No evidence matches these filters', recovery: 'Clear filters' };
  }
  if (state.requests.query.status === 'error' && state.accepted.items.length > 0) {
    return { key: 'partial-catalog', title: 'Some evidence metadata could not be loaded', recovery: 'Retry this window' };
  }
  if (state.availability?.state === 'tombstone' || state.media.status === 'error') {
    return { key: 'selected-blob-unavailable', title: 'The selected evidence is unavailable', recovery: 'Retry this member' };
  }
  if (state.requests.query.status === 'loading' && state.accepted.items.length > 0) {
    return { key: 'partial-catalog', title: 'Current evidence is usable while more metadata loads', recovery: null };
  }
  if (state.phase === 'loading' || state.requests.head.status === 'loading' || state.requests.query.status === 'loading') {
    return { key: 'loading', title: 'Loading visual evidence', recovery: null };
  }
  return { key: 'ready', title: 'Visual evidence ready', recovery: null };
}

function trustedResolvedMedia(value) {
  if (!value || value.validatedByAdapter !== true || typeof value.url !== 'string') return null;
  const safe = isContainedRelativeMediaUrl(value.url);
  if (!safe) return null;
  return Object.freeze({
    validatedByAdapter: true,
    url: value.url,
    posterUrl: typeof value.posterUrl === 'string' && value.posterUrl !== value.url
      ? trustedResolvedMedia({ validatedByAdapter: true, url: value.posterUrl })?.url ?? null
      : null,
  });
}

function isContainedRelativeMediaUrl(value) {
  if (
    typeof value !== 'string'
    || value === ''
    || value.startsWith('//')
    || value.includes('\\')
    || value.includes('?')
    || value.includes('#')
    || /[\u0000-\u001f\u007f]/.test(value)
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
  ) return false;
  const portalArtifact = value.startsWith('/artifacts/');
  const archiveEvidence = value.startsWith('evidence/') || value.startsWith('./evidence/');
  const singleSiteMedia = /^\/api\/single-site\/(?:runs\/[A-Za-z0-9._:-]+\/gallery\/items\/[A-Za-z0-9%._:-]+\/media\/(?:current|diff|poster)|visual-baselines\/[A-Za-z0-9%._:-]+\/media)$/.test(value);
  if (!portalArtifact && !archiveEvidence && !singleSiteMedia) return false;
  const relative = value.startsWith('/') ? value.slice(1) : value.replace(/^\.\//, '');
  if (!relative) return false;
  for (const encoded of relative.split('/')) {
    if (!encoded) return false;
    let segment;
    try { segment = decodeURIComponent(encoded); } catch { return false; }
    if (segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\') || /[\u0000-\u001f\u007f]/.test(segment)) return false;
  }
  return true;
}

export function shouldSuppressGalleryShortcut(event) {
  if (!event || event.defaultPrevented || event.isComposing || event.repeat && event.key === '?') return true;
  if (event.altKey || event.ctrlKey || event.metaKey) return true;
  const target = event.target;
  const tag = String(target?.tagName ?? '').toLowerCase();
  if (['input', 'textarea', 'select', 'option', 'video', 'audio'].includes(tag)) return true;
  if (target?.isContentEditable) return true;
  const role = target?.getAttribute?.('role');
  if (['textbox', 'combobox', 'slider', 'spinbutton'].includes(role)) return true;
  if (target?.closest?.('dialog,[role="dialog"],[data-gallery-shortcuts="owned"]')) return true;
  return Boolean(event.shiftKey && !['?', '[', ']'].includes(event.key));
}

export function selectNavigationTarget(state, direction, byTest = false) {
  const items = state.accepted.items;
  const index = items.findIndex(({ id }) => id === state.selection.itemId);
  if (index < 0) return null;
  if (!byTest) return items[index + direction]?.id ?? null;
  const currentGroup = items[index].testGroupId;
  const localOrdinal = items.slice(0, index).filter(({ testGroupId }) => testGroupId === currentGroup).length;
  let cursor = index + direction;
  while (cursor >= 0 && cursor < items.length && items[cursor].testGroupId === currentGroup) cursor += direction;
  if (cursor < 0 || cursor >= items.length) return null;
  const destinationGroup = items[cursor].testGroupId;
  const destination = items.filter(({ testGroupId }) => testGroupId === destinationGroup);
  return destination[Math.min(localOrdinal, destination.length - 1)]?.id ?? null;
}

function element(doc, tag, className, text = null) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== null) node.textContent = String(text);
  return node;
}

function bdi(doc, text) {
  const node = element(doc, 'bdi', null, text ?? 'Not recorded');
  node.dir = 'auto';
  return node;
}

function button(doc, label, action, onAction) {
  const node = element(doc, 'button', 'gallery-button', label);
  node.type = 'button';
  node.dataset.galleryAction = action;
  node.addEventListener('click', onAction);
  return node;
}

function clearVideo(video) {
  if (!video) return;
  try { video.pause(); } catch { /* A detached fake or browser video may not implement pause. */ }
  video.removeAttribute('src');
  try { video.load(); } catch { /* Clearing the source is the authoritative cancellation. */ }
}

function renderRegionsForAction(action) {
  const type = action.type;
  if (type === 'SET_PLAYBACK') return [];
  if (type.startsWith('REQUEST_')) {
    if (action.slot === 'thumbnail') return [];
    if (action.slot === 'media') return ['status', 'viewer'];
    // A retry begins with the previous detail cleared and its error still
    // visible in the viewer. Re-render the viewer for every detail lifecycle
    // transition so the retry exposes its pending state immediately instead
    // of leaving a stale error card mounted until the response arrives.
    if (action.slot === 'detail') return ['status', 'viewer', 'context'];
    if (action.slot === 'availability') return ['status', 'context'];
    if (action.slot === 'flag') return ['status', 'context'];
    return ['status', 'controls', 'queue', 'viewer', 'filmstrip', 'context', 'overview'];
  }
  if (type === 'THUMBNAIL_SUCCEEDED') return ['filmstrip', 'overview'];
  if (type === 'SELECT_ITEM') return ['status', 'queue', 'viewer', 'filmstrip', 'context'];
  if (type === 'QUERY_SUCCEEDED' && !action.acceptPending) {
    // SET_QUERY already rendered the chosen controls. Keep those elements
    // mounted while the result arrives so a reviewer does not lose focus (or
    // an immediately-following Escape key) to an unrelated data refresh.
    return ['status', 'queue', 'viewer', 'filmstrip', 'context', 'overview'];
  }
  if (type === 'MEDIA_SUCCEEDED' || type === 'AVAILABILITY_SUCCEEDED') return ['status', 'viewer'];
  // The loaded media element is already the authoritative selected element.
  // Replacing it after load causes a second image decode/video metadata load
  // and moves that work into the next keyboard traversal. The load handler
  // removes its progress indicator in place; only status needs reconciliation.
  if (type === 'MEDIA_ELEMENT_LOADED') return ['status'];
  if (type === 'MEDIA_ELEMENT_FAILED' || type === 'POSTER_ELEMENT_FAILED') return ['status', 'viewer'];
  if (type === 'DETAIL_SUCCEEDED' || type === 'SET_MEMBER') return ['status', 'viewer', 'context'];
  if (type === 'OPEN_LAYER' || type === 'CLOSE_LAYER' || type === 'FULLSCREEN_CHANGED' || type === 'ESCAPE_LAYER') {
    // Layer and fullscreen state do not change the selected media. Keeping the
    // viewer DOM mounted preserves video playback, avoids duplicate range
    // requests, and prevents a help/context action from resetting currentTime.
    return ['controls', 'queue', 'context', 'overview', 'help'];
  }
  if (type === 'SET_MODE') return ['controls', 'queue', 'viewer', 'filmstrip', 'context', 'overview'];
  return ['status', 'controls', 'queue', 'viewer', 'filmstrip', 'context', 'overview', 'help'];
}

export function createGalleryWorkbench(root, options = {}) {
  if (!root?.ownerDocument) throw new TypeError('A gallery root element is required.');
  const doc = root.ownerDocument;
  const adapter = options.adapter ?? {};
  const presentation = options.presentation ?? null;
  const focusViewerAfterSelection = options.focusViewerAfterSelection === true;
  const scheduler = options.scheduler ?? ((task) => queueMicrotask(task));
  const thumbnailScheduler = options.thumbnailScheduler ?? ((task) => {
    const view = doc.defaultView;
    const setTimer = view?.setTimeout?.bind(view) ?? globalThis.setTimeout.bind(globalThis);
    const clearTimer = view?.clearTimeout?.bind(view) ?? globalThis.clearTimeout.bind(globalThis);
    let timerId = setTimer(() => {
      timerId = null;
      if (typeof view?.requestIdleCallback === 'function') {
        idleId = view.requestIdleCallback(task, { timeout: 500 });
      } else task();
    }, 150);
    let idleId = null;
    return () => {
      if (timerId !== null) clearTimer(timerId);
      if (idleId !== null) view?.cancelIdleCallback?.(idleId);
      timerId = null;
      idleId = null;
    };
  });
  const announceSink = typeof options.announce === 'function' ? options.announce : () => {};
  const focusByKey = typeof options.focusByKey === 'function'
    ? options.focusByKey
    : (key) => root.querySelector?.(`[data-focus-key="${key}"]`)?.focus?.();
  const viewportMode = typeof options.viewportMode === 'function'
    ? options.viewportMode
    : () => {
        const width = root.ownerDocument.defaultView?.innerWidth ?? 1_024;
        return width < 768 ? 'mobile' : width < 1_024 ? 'tablet' : 'desktop';
      };
  let state = createInitialGalleryState(options.initialState);
  let renderQueued = false;
  let activeVideo = null;
  let destroyed = false;
  let lastAnnouncement = '';
  const dirtyRegions = new Set();
  const thumbnailQueue = [];
  let thumbnailPumpGeneration = 0;
  let activeThumbnailPump = null;
  let cancelScheduledThumbnailPump = null;
  let thumbnailForegroundPending = false;
  let firstUsableEmitted = false;
  let thumbnailResolutionEnabled = false;
  let activeOverviewObserver = null;
  let pendingFocusRestoreKey = null;
  let renderedQueueItems = null;
  let renderedQueueGroup = null;
  let renderedQueueViewport = null;
  let renderedFilmstripItems = null;
  let renderedFilmstripIds = [];
  let renderedFilmstripThumbnails = '';
  let renderedFilmstripResolutionEnabled = false;
  const subscribers = new Set();
  const controllers = new Map();
  const generations = Object.fromEntries(REQUEST_SLOTS.map((slot) => [slot, 0]));

  const regionClass = (base, key) => options.replaceDefaultClasses && options.classes?.[key]
    ? options.classes[key]
    : [base, options.classes?.[key]].filter(Boolean).join(' ');
  const shell = element(doc, 'section', regionClass('gallery-shell', 'shell'));
  shell.tabIndex = 0;
  shell.dataset.galleryRegion = 'root';
  shell.dataset.focusKey = 'gallery-root';
  const statusRegion = element(doc, 'header', regionClass('gallery-status', 'status'));
  statusRegion.setAttribute('role', 'status');
  statusRegion.setAttribute('aria-live', 'polite');
  statusRegion.setAttribute('aria-atomic', 'true');
  const controlsRegion = element(doc, 'nav', regionClass('gallery-controls', 'controls'));
  controlsRegion.setAttribute('aria-label', 'Visual evidence controls');
  const bodyRegion = element(doc, 'div', regionClass('gallery-body', 'body'));
  const queueRegion = element(doc, 'aside', regionClass('gallery-queue', 'queue'));
  queueRegion.dataset.galleryRegion = 'queue';
  const viewerColumn = element(doc, 'main', regionClass('gallery-viewer-column', 'viewerColumn'));
  const viewerRegion = element(doc, 'div', regionClass('gallery-viewer', 'viewer'));
  viewerRegion.dataset.galleryRegion = 'viewer';
  viewerRegion.dataset.focusKey = 'gallery-viewer';
  viewerRegion.tabIndex = 0;
  const filmstripRegion = element(doc, 'div', regionClass('gallery-filmstrip', 'filmstrip'));
  filmstripRegion.setAttribute('role', 'region');
  const contextRegion = element(doc, 'aside', regionClass('gallery-context', 'context'));
  contextRegion.dataset.galleryRegion = 'context';
  contextRegion.tabIndex = 0;
  const overviewRegion = element(doc, 'main', regionClass('gallery-overview', 'overview'));
  overviewRegion.dataset.galleryRegion = 'overview';
  viewerColumn.append(viewerRegion, filmstripRegion);
  bodyRegion.append(queueRegion, viewerColumn, contextRegion, overviewRegion);
  shell.append(statusRegion, controlsRegion, bodyRegion);
  root.replaceChildren(shell);

  function announce(message) {
    const bounded = String(message ?? '').replace(/\s+/g, ' ').trim().slice(0, GALLERY_LIMITS.announcementCharacters);
    if (!bounded || bounded === lastAnnouncement) return;
    lastAnnouncement = bounded;
    announceSink(bounded);
  }

  function dispatch(action) {
    const previousAsyncState = selectAsyncState(state);
    const next = galleryReducer(state, action);
    if (next === state) return state;
    const activeFocusKey = doc.activeElement && shell.contains(doc.activeElement)
      ? doc.activeElement.dataset?.focusKey ?? null
      : null;
    if (activeFocusKey) pendingFocusRestoreKey = activeFocusKey;
    state = next;
    const nextAsyncState = selectAsyncState(state);
    if (nextAsyncState.key !== previousAsyncState.key) announce(nextAsyncState.title);
    for (const subscriber of subscribers) subscriber(state, action);
    for (const region of renderRegionsForAction(action)) dirtyRegions.add(region);
    if (!renderQueued) {
      renderQueued = true;
      scheduler(() => {
        renderQueued = false;
        if (!destroyed) {
          const targets = new Set(dirtyRegions);
          dirtyRegions.clear();
          render(targets);
          if (pendingFocusRestoreKey) {
            const focusKey = pendingFocusRestoreKey;
            pendingFocusRestoreKey = null;
            focusByKey(focusKey);
          }
        }
      });
    }
    if (typeSettlesThumbnailForeground(action)) settleThumbnailResolution();
    return state;
  }

  function abort(slot) {
    const existing = controllers.get(slot);
    if (!existing) return;
    existing.controller.abort();
    dispatch({ type: 'REQUEST_CANCELLED', slot, generation: existing.generation, semanticKey: existing.semanticKey });
    controllers.delete(slot);
  }

  async function request(slot, semanticKey, work, success) {
    abort(slot);
    const generation = ++generations[slot];
    const controller = new AbortController();
    controllers.set(slot, { controller, generation, semanticKey });
    dispatch({ type: 'REQUEST_STARTED', slot, generation, semanticKey });
    try {
      const value = await work(controller.signal);
      if (controller.signal.aborted) return null;
      dispatch(success(value, generation, semanticKey));
      return value;
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') return null;
      if (error?.status === 410 || error?.code === 'GALLERY_RUN_PURGED') dispatch({ type: 'PURGED' });
      else dispatch({ type: 'REQUEST_FAILED', slot, generation, semanticKey, error: error?.message ?? error });
      return null;
    } finally {
      if (controllers.get(slot)?.generation === generation) controllers.delete(slot);
    }
  }

  async function loadHead() {
    if (typeof adapter.loadHead !== 'function') return null;
    return request('head', 'head', (signal) => adapter.loadHead({ signal }), (head, generation, semanticKey) => ({
      type: 'HEAD_SUCCEEDED', slot: 'head', generation, semanticKey, head,
    }));
  }

  async function loadSequence({
    append = false,
    restoreAnchor = true,
    revision = null,
    orderRevision = null,
    flagRevision = null,
    acceptPending = false,
    preferredItemId = null,
  } = {}) {
    if (typeof adapter.loadItems !== 'function') return null;
    const anchorItemId = append ? null : preferredItemId
      ?? (restoreAnchor ? state.selection.outOfFilterAnchor ?? state.selection.itemId : null);
    const key = `${queryKey(state.query)}|${revision ?? state.accepted.contentRevision ?? 'head'}|${orderRevision ?? state.accepted.orderRevision ?? ''}|${flagRevision ?? state.accepted.flagRevision ?? ''}|${append ? state.accepted.nextCursor ?? '' : ''}`;
    const result = await request('query', key, (signal) => adapter.loadItems({
      query: state.query,
      contentRevision: revision ?? state.accepted.contentRevision,
      orderRevision: orderRevision ?? state.accepted.orderRevision,
      flagRevision: flagRevision ?? state.accepted.flagRevision,
      cursor: append ? state.accepted.nextCursor : null,
      limit: GALLERY_LIMITS.pageRows,
      anchorItemId,
      signal,
    }), (value, generation, semanticKey) => ({
      type: 'QUERY_SUCCEEDED',
      slot: 'query',
      generation,
      semanticKey,
      rows: value.items ?? value.rows,
      total: value.total,
      offset: value.offset,
      nextCursor: value.nextCursor,
      contentRevision: value.contentRevision ?? revision,
      orderRevision: value.orderRevision,
      flagRevision: value.flagRevision ?? flagRevision,
      phase: value.phase,
      append,
      restoreAnchor,
      acceptPending,
      preferredItemId,
    }));
    if (result && state.selection.itemId && !append) await loadSelected();
    return result;
  }

  async function loadSelected({ foregroundAlreadyPaused = false } = {}) {
    if (!foregroundAlreadyPaused) pauseThumbnailResolution();
    abort('detail');
    abort('availability');
    abort('media');
    const itemId = state.selection.itemId;
    if (!itemId || typeof adapter.loadItem !== 'function') {
      settleThumbnailResolution();
      return null;
    }
    const key = `${state.accepted.contentRevision}|${itemId}`;
    const result = await request('detail', key, (signal) => adapter.loadItem({
      itemId,
      contentRevision: state.accepted.contentRevision,
      signal,
    }), (detail, generation, semanticKey) => ({
      type: 'DETAIL_SUCCEEDED', slot: 'detail', generation, semanticKey, itemId, contentRevision: state.accepted.contentRevision, detail,
    }));
    if (result && state.selection.itemId === itemId) {
      await resolveSelectedMedia({ foregroundAlreadyPaused: true });
    }
    return result;
  }

  async function resolveSelectedMedia({ foregroundAlreadyPaused = false } = {}) {
    if (!foregroundAlreadyPaused) pauseThumbnailResolution();
    abort('media');
    const itemId = state.selection.itemId;
    const memberId = state.selection.memberId;
    if (!itemId || !memberId || !state.detail || typeof adapter.resolveMedia !== 'function') {
      settleThumbnailResolution();
      return null;
    }
    const media = state.detail.media.find((entry) => entry.memberId === memberId);
    const key = `${state.accepted.contentRevision}|${itemId}|${memberId}`;
    return request('media', key, (signal) => adapter.resolveMedia({
      item: state.detail.item,
      member: state.detail.item.members.find(({ id }) => id === memberId),
      mediaReference: media?.adapterReference ?? null,
      posterReference: media?.adapterPosterReference ?? null,
      signal,
    }), (source, generation, semanticKey) => ({
      type: 'MEDIA_SUCCEEDED', slot: 'media', generation, semanticKey, itemId, memberId,
      contentRevision: state.accepted.contentRevision, source,
    }));
  }

  async function probeSelectedAvailability() {
    const itemId = state.selection.itemId;
    if (!itemId || typeof adapter.loadAvailability !== 'function') return null;
    const key = `${state.accepted.contentRevision}|${state.accepted.orderRevision}|${state.accepted.flagRevision}|${itemId}`;
    return request('availability', key, (signal) => adapter.loadAvailability({
      itemId,
      contentRevision: state.accepted.contentRevision,
      orderRevision: state.accepted.orderRevision,
      flagRevision: state.accepted.flagRevision,
      signal,
    }), (availability, generation, semanticKey) => ({
      type: 'AVAILABILITY_SUCCEEDED', slot: 'availability', generation, semanticKey,
      itemId, contentRevision: state.accepted.contentRevision, availability,
    }));
  }

  async function retrySelectedMedia() {
    const availability = await probeSelectedAvailability();
    if (!availability || availability.state === 'tombstone') return availability;
    return loadSelected();
  }

  async function resolveThumbnailNow(row) {
    if (!row || state.thumbnails[row.id] || row.kind !== 'image' || typeof adapter.resolveThumbnail !== 'function') return null;
    const key = `${state.accepted.contentRevision}|thumb|${row.id}`;
    return request('thumbnail', key, (signal) => adapter.resolveThumbnail({ row, signal }), (source, generation, semanticKey) => ({
      type: 'THUMBNAIL_SUCCEEDED', slot: 'thumbnail', generation, semanticKey, itemId: row.id,
      contentRevision: state.accepted.contentRevision, source,
    }));
  }

  function typeSettlesThumbnailForeground(action) {
    return action.type === 'MEDIA_ELEMENT_LOADED'
      || action.type === 'MEDIA_ELEMENT_FAILED'
      || (action.type === 'REQUEST_FAILED' && (action.slot === 'detail' || action.slot === 'media'));
  }

  function cancelThumbnailSchedule() {
    cancelScheduledThumbnailPump?.();
    cancelScheduledThumbnailPump = null;
  }

  function pauseThumbnailResolution(retainItemId = null) {
    thumbnailForegroundPending = true;
    thumbnailPumpGeneration += 1;
    cancelThumbnailSchedule();
    thumbnailQueue.length = 0;
    activeThumbnailPump = null;
    const activeThumbnail = controllers.get('thumbnail');
    const retainedThumbnailKey = retainItemId
      ? `${state.accepted.contentRevision}|thumb|${retainItemId}`
      : null;
    if (!activeThumbnail || activeThumbnail.semanticKey !== retainedThumbnailKey) abort('thumbnail');
  }

  function settleThumbnailResolution() {
    if (!thumbnailForegroundPending) return;
    thumbnailForegroundPending = false;
    // Selection renders may have queued the window in DOM order while
    // foreground work was paused. Rebuild it in navigation-priority order.
    thumbnailQueue.length = 0;
    enqueueLocalThumbnailWindow();
    scheduleThumbnailPump();
  }

  function enqueueLocalThumbnailWindow() {
    if (!thumbnailResolutionEnabled) return;
    const rows = selectLocalFilmstrip(state);
    const selectedIndex = rows.findIndex(({ id }) => id === state.selection.itemId);
    const prioritized = [];
    if (selectedIndex >= 0) {
      // Review normally advances through evidence. Warm the next item first,
      // then alternate backward/forward neighbors; retain the selected tile
      // last because its full-size media is already visible.
      for (let distance = 1; distance < rows.length; distance += 1) {
        if (rows[selectedIndex + distance]) prioritized.push(rows[selectedIndex + distance]);
        if (rows[selectedIndex - distance]) prioritized.push(rows[selectedIndex - distance]);
      }
      prioritized.push(rows[selectedIndex]);
    } else prioritized.push(...rows);
    for (const row of prioritized) {
      if (row.kind !== 'image' || state.thumbnails[row.id]
        || thumbnailQueue.some(({ id }) => id === row.id)) continue;
      thumbnailQueue.push(row);
    }
  }

  function scheduleThumbnailPump() {
    if (destroyed || thumbnailForegroundPending || !thumbnailResolutionEnabled
      || thumbnailQueue.length === 0 || activeThumbnailPump !== null) return;
    cancelThumbnailSchedule();
    const generation = thumbnailPumpGeneration;
    cancelScheduledThumbnailPump = thumbnailScheduler(() => {
      cancelScheduledThumbnailPump = null;
      if (destroyed || thumbnailForegroundPending || generation !== thumbnailPumpGeneration) return;
      void pumpThumbnailQueue(generation);
    });
  }

  async function pumpThumbnailQueue(generation) {
    if (activeThumbnailPump !== null) return;
    activeThumbnailPump = generation;
    try {
      while (thumbnailQueue.length > 0 && !destroyed && !thumbnailForegroundPending
        && generation === thumbnailPumpGeneration) {
        await resolveThumbnailNow(thumbnailQueue.shift());
      }
    } finally {
      if (activeThumbnailPump === generation) activeThumbnailPump = null;
      if (!thumbnailForegroundPending && thumbnailQueue.length > 0) scheduleThumbnailPump();
    }
  }

  function resolveThumbnail(row) {
    if (!row || state.thumbnails[row.id] || thumbnailQueue.some(({ id }) => id === row.id)) return;
    thumbnailQueue.push(row);
    scheduleThumbnailPump();
  }

  async function initialize() {
    const head = await loadHead();
    if (!head) return;
    if (head.phase === 'waiting') return;
    await loadSequence({ revision: head.contentRevision });
  }

  async function setQuery(next) {
    dispatch({ type: 'SET_QUERY', query: { ...state.query, ...next } });
    await loadSequence({ restoreAnchor: true });
  }

  async function selectItem(itemId, selectionOptions = {}) {
    // If the quiet-period scheduler is already warming the newly selected
    // item, retain that exact request. The selected-detail consumer will join
    // it through the adapter cache; any other thumbnail request is cancelled.
    pauseThumbnailResolution(itemId);
    abort('detail');
    abort('availability');
    abort('media');
    dispatch({ type: 'SELECT_ITEM', itemId, ...selectionOptions });
    const selected = selectSelectedRow(state);
    const position = selectSequencePosition(state);
    if (selected) announce(`${selected.kind === 'video' ? 'Video' : 'Photo'} ${position.ordinal} of ${position.total}. ${selected.title}. ${selected.status}.`);
    await loadSelected({ foregroundAlreadyPaused: true });
    if (focusViewerAfterSelection) {
      scheduler(() => viewerRegion.focus?.({ preventScroll: true }));
    }
  }

  async function selectMember(delta) {
    pauseThumbnailResolution();
    abort('media');
    const prior = state.selection.memberId;
    dispatch({ type: 'SET_MEMBER', delta });
    if (state.selection.memberId === prior) {
      settleThumbnailResolution();
      announce('You reached the end of this comparison.');
      return;
    }
    const member = selectSelectedMember(state);
    if (member) announce(`${member.role} comparison member selected.`);
    await resolveSelectedMedia({ foregroundAlreadyPaused: true });
  }

  async function selectMemberById(memberId) {
    pauseThumbnailResolution();
    abort('media');
    const prior = state.selection.memberId;
    dispatch({ type: 'SET_MEMBER', memberId });
    if (state.selection.memberId === prior) {
      settleThumbnailResolution();
      return;
    }
    const member = selectSelectedMember(state);
    if (member) announce(`${member.role} comparison member selected.`);
    await resolveSelectedMedia({ foregroundAlreadyPaused: true });
  }

  async function applyPendingRevision() {
    const pending = state.pendingRevision;
    if (!pending) return;
    dispatch({ type: 'APPLY_PENDING_REVISION' });
    await loadSequence({
      revision: pending.contentRevision,
      orderRevision: pending.orderRevision,
      flagRevision: pending.flagRevision,
      acceptPending: true,
    });
  }

  async function mutateFlag(transition) {
    if (!state.capability.flagsMutable || typeof adapter.mutateFlag !== 'function') {
      announce('Reviewer flags are read-only in this gallery.');
      return null;
    }
    const itemId = state.selection.itemId;
    const key = `${itemId}|${transition.action}|${transition.idempotencyKey ?? ''}`;
    return request('flag', key, (signal) => adapter.mutateFlag({ ...transition, itemId, signal }), (result, generation, semanticKey) => ({
      type: 'FLAG_SUCCEEDED', slot: 'flag', generation, semanticKey, itemId, result, pendingRevision: result.pendingRevision,
    }));
  }

  async function navigate(direction, byTest = false) {
    let itemId = typeof presentation?.selectNavigationTarget === 'function'
      ? presentation.selectNavigationTarget(state, direction, byTest)
      : selectNavigationTarget(state, direction, byTest);
    if (!itemId && direction > 0 && state.accepted.nextCursor) {
      await loadSequence({ append: true, restoreAnchor: false });
      itemId = typeof presentation?.selectNavigationTarget === 'function'
        ? presentation.selectNavigationTarget(state, direction, byTest)
        : selectNavigationTarget(state, direction, byTest);
    }
    if (!itemId) {
      announce(byTest ? 'No more test groups in that direction.' : 'You reached the end of this evidence sequence.');
      return;
    }
    await selectItem(itemId);
  }

  function restoreFocus(key = state.layers.focusHistory.at(-1)) {
    if (key) scheduler(() => focusByKey(key));
  }

  async function toggleFullscreen() {
    const fullscreen = options.fullscreen;
    if (!fullscreen) {
      announce('Fullscreen is not available in this viewer.');
      return;
    }
    try {
      if (fullscreen.isActive?.()) await fullscreen.exit();
      else await fullscreen.enter(viewerRegion);
      const active = Boolean(fullscreen.isActive?.());
      dispatch({ type: 'FULLSCREEN_CHANGED', active });
      announce(active ? 'Viewer entered fullscreen.' : 'Viewer left fullscreen.');
    } catch (error) {
      dispatch({ type: 'FULLSCREEN_CHANGED', active: Boolean(fullscreen.isActive?.()) });
      announce(`Fullscreen did not change. ${error?.message ?? ''}`);
    }
  }

  function unwindEscape() {
    const was = state;
    if (was.layers.fullscreen && options.fullscreen?.isActive?.()) {
      void toggleFullscreen();
      return;
    }
    dispatch({ type: 'ESCAPE_LAYER' });
    if (was.layers.help || was.layers.responsivePanel || was.layers.context) restoreFocus(was.layers.focusHistory.at(-1));
    else if (was.mode !== 'overview' && was.history.length > 0) restoreFocus(was.history.at(-1)?.focusKey);
  }

  function onKeydown(event) {
    if (options.isInteractionBlocked?.() || shouldSuppressGalleryShortcut(event)) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    let handled = true;
    if (key === GALLERY_KEYS.previousItem) void navigate(-1, false);
    else if (key === GALLERY_KEYS.nextItem) void navigate(1, false);
    else if (key === GALLERY_KEYS.previousTest) void navigate(-1, true);
    else if (key === GALLERY_KEYS.nextTest) void navigate(1, true);
    else if (event.key === GALLERY_KEYS.previousMember) void selectMember(-1);
    else if (event.key === GALLERY_KEYS.nextMember) void selectMember(1);
    else if (event.key === GALLERY_KEYS.playPause) {
      if (state.detail?.item.kind !== 'video' || !viewerRegion.contains(event.target) || event.target === activeVideo) handled = false;
      else if (activeVideo) {
        if (activeVideo.paused) void activeVideo.play(); else activeVideo.pause();
      }
    } else if (key === GALLERY_KEYS.context) {
      if (state.layers.context) {
        dispatch({ type: 'CLOSE_LAYER', layer: 'context' });
        restoreFocus();
      } else dispatch({ type: 'OPEN_LAYER', layer: 'context', focusKey: event.target?.dataset?.focusKey ?? 'context-toggle' });
    } else if (key === GALLERY_KEYS.fullscreen) void toggleFullscreen();
    else if (key === GALLERY_KEYS.escape) unwindEscape();
    else if (event.key === GALLERY_KEYS.help) dispatch({ type: 'OPEN_LAYER', layer: 'help', focusKey: event.target?.dataset?.focusKey ?? 'gallery-root' });
    else handled = false;
    if (handled) {
      event.preventDefault?.();
      event.stopPropagation?.();
    }
  }

  shell.addEventListener('keydown', onKeydown);
  let renderedViewportMode = viewportMode();
  function onViewportResize() {
    const nextViewportMode = viewportMode();
    if (nextViewportMode === renderedViewportMode) return;
    renderedViewportMode = nextViewportMode;
    if (nextViewportMode === 'desktop' && state.layers.responsivePanel) {
      dispatch({ type: 'CLOSE_LAYER', layer: 'responsivePanel' });
      return;
    }
    render(new Set(['controls', 'queue', 'context', 'overview']));
    presentation?.onViewportModeChange?.(renderContextForPresentation());
  }
  doc.defaultView?.addEventListener?.('resize', onViewportResize);

  function renderContextForPresentation() {
    return {
      state,
      doc,
      root,
      shell,
      statusRegion,
      controlsRegion,
      bodyRegion,
      queueRegion,
      viewerColumn,
      viewerRegion,
      filmstripRegion,
      contextRegion,
      overviewRegion,
      viewportMode,
      announce,
      dispatch,
      setQuery,
      selectItem,
      selectMember,
      selectMemberById,
      navigate,
      retrySelectedMedia,
      loadSelected,
      loadSequence,
      toggleFullscreen,
      setActiveVideo(video) { activeVideo = video; },
    };
  }

  function renderStatus() {
    if (typeof presentation?.renderStatus === 'function') {
      presentation.renderStatus(renderContextForPresentation());
      return;
    }
    const asyncState = selectAsyncState(state);
    const position = selectSequencePosition(state);
    statusRegion.replaceChildren();
    const copy = element(doc, 'div', 'gallery-status-copy');
    const title = element(doc, 'strong', null, asyncState.title);
    const row = selectSelectedRow(state);
    const suite = row ? (state.query.group === 'technical' ? row.technicalSuite : row.primaryFeatureSuite) : null;
    const suites = [...new Set(state.accepted.items.map((item) => (
      state.query.group === 'technical' ? item.technicalSuite : item.primaryFeatureSuite
    )).filter(Boolean))];
    const suitePosition = suite ? `${Math.max(0, suites.indexOf(suite)) + 1} of ${suites.length}` : 'not grouped';
    const count = element(doc, 'span', null, `${position.ordinal} of ${position.total}${row ? ` · ${row.kind} · ${row.status} · suite ${suitePosition}` : ''}`);
    copy.append(title, count);
    statusRegion.append(copy);
    if (state.pendingRevision) {
      const notice = element(doc, 'div', 'gallery-revision-notice');
      notice.append(
        bdi(doc, `${state.pendingRevision.attentionCount} new attention item${state.pendingRevision.attentionCount === 1 ? '' : 's'} available.`),
        button(doc, 'Apply updated order', 'apply-revision', () => void applyPendingRevision()),
      );
      statusRegion.append(notice);
    }
    if (asyncState.recovery && asyncState.key !== 'ready') {
      statusRegion.append(button(doc, asyncState.recovery, 'recover', () => {
        if (asyncState.key === 'zero-filtered-results') void setQuery(EMPTY_QUERY);
        else if (asyncState.key === 'selected-blob-unavailable') void retrySelectedMedia();
        else if (!state.purged) void initialize();
      }));
    }
  }

  function renderControls() {
    if (typeof presentation?.renderControls === 'function') {
      presentation.renderControls(renderContextForPresentation());
      return;
    }
    const compact = viewportMode() !== 'desktop';
    controlsRegion.replaceChildren(
      button(doc, state.mode === 'workbench' ? 'Overview' : 'Workbench', 'toggle-mode', () => dispatch({
        type: 'SET_MODE', mode: state.mode === 'workbench' ? 'overview' : 'workbench',
      })),
      button(doc, 'Test queue', 'queue-panel', () => {
        if (!compact) return queueRegion.focus?.();
        dispatch({ type: 'OPEN_LAYER', layer: 'responsivePanel', panel: 'queue', focusKey: 'queue-toggle' });
        scheduler(() => focusByKey('queue-heading'));
      }),
      button(doc, 'Previous', 'previous', () => navigate(-1)),
      button(doc, 'Next', 'next', () => navigate(1)),
      button(doc, state.layers.context ? 'Test context' : 'Show context', 'context', () => {
        if (compact) {
          if (!state.layers.context) dispatch({ type: 'OPEN_LAYER', layer: 'context', focusKey: 'context-toggle' });
          dispatch({ type: 'OPEN_LAYER', layer: 'responsivePanel', panel: 'context', focusKey: 'context-toggle' });
          scheduler(() => focusByKey('context-heading'));
        } else dispatch({ type: state.layers.context ? 'CLOSE_LAYER' : 'OPEN_LAYER', layer: 'context', focusKey: 'context-toggle' });
      }),
      button(doc, 'Shortcuts', 'help', () => dispatch({ type: 'OPEN_LAYER', layer: 'help', focusKey: 'help-toggle' })),
      button(doc, 'Filters', 'filters-panel', () => {
        if (!compact) return focusByKey('gallery-search');
        dispatch({ type: 'OPEN_LAYER', layer: 'responsivePanel', panel: 'filters', focusKey: 'filters-toggle' });
        scheduler(() => focusByKey('gallery-search'));
      }),
      button(doc, 'Previous comparison', 'previous-member', () => void selectMember(-1)),
      button(doc, 'Next comparison', 'next-member', () => void selectMember(1)),
      button(doc, state.layers.fullscreen ? 'Leave fullscreen' : 'Fullscreen', 'fullscreen', () => void toggleFullscreen()),
    );
    controlsRegion.children?.[1]?.setAttribute?.('data-focus-key', 'queue-toggle');
    controlsRegion.children?.[4]?.setAttribute?.('data-focus-key', 'context-toggle');
    controlsRegion.children?.[5]?.setAttribute?.('data-focus-key', 'help-toggle');
    controlsRegion.children?.[6]?.setAttribute?.('data-focus-key', 'filters-toggle');
    const filters = element(doc, 'div', 'gallery-filters');
    const facetValues = state.descriptor?.facets ?? {};
    const filterSpecs = [
      ['Media', 'kinds', [['', 'Photos and videos'], ['image', 'Photos'], ['video', 'Videos']]],
      ['Status', 'statuses', (facetValues.statuses ?? []).map((value) => [value, value])],
      ['Environment', 'environments', (facetValues.environments ?? []).map((value) => [value, value])],
      ['Feature suite', 'featureSuites', (facetValues.featureSuites ?? []).map((value) => [value, value])],
      ['Technical suite', 'technicalSuites', (facetValues.technicalSuites ?? []).map((value) => [value, value])],
      ['Browser or device', 'targets', (facetValues.targets ?? []).map((value) => [value, value])],
      ['Reviewer flag', 'flagStates', (facetValues.flagStates ?? []).map((value) => [value, value])],
    ];
    for (const [labelText, key, choices] of filterSpecs) {
      const label = element(doc, 'label', 'gallery-filter');
      label.append(element(doc, 'span', null, labelText));
      const select = element(doc, 'select');
      select.dataset.queryKey = key;
      select.dataset.focusKey = `filter-${key}`;
      const all = element(doc, 'option', null, key === 'kinds' ? choices[0][1] : `All ${labelText.toLowerCase()}`);
      all.value = '';
      select.append(all);
      const start = key === 'kinds' ? choices.slice(1) : choices;
      for (const [value, copy] of start.slice(0, GALLERY_LIMITS.facetOptions)) {
        const option = element(doc, 'option', null);
        option.value = value;
        option.textContent = copy;
        option.selected = state.query[key]?.includes(value) ?? false;
        select.append(option);
      }
      select.value = state.query[key]?.[0] ?? '';
      select.addEventListener('change', () => void setQuery({ [key]: select.value ? [select.value] : [] }));
      label.append(select);
      filters.append(label);
    }
    const groupLabel = element(doc, 'label', 'gallery-filter');
    groupLabel.append(element(doc, 'span', null, 'Group by'));
    const groupSelect = element(doc, 'select');
    for (const [value, copy] of [['feature', 'Feature suite'], ['technical', 'Technical suite'], ['none', 'No grouping']]) {
      const option = element(doc, 'option', null, copy);
      option.value = value;
      option.selected = state.query.group === value;
      groupSelect.append(option);
    }
    groupSelect.value = state.query.group;
    groupSelect.dataset.focusKey = 'gallery-group';
    groupSelect.addEventListener('change', () => void setQuery({ group: groupSelect.value }));
    groupLabel.append(groupSelect);
    filters.append(groupLabel);
    const sortLabel = element(doc, 'label', 'gallery-filter');
    sortLabel.append(element(doc, 'span', null, 'Sort'));
    const sortSelect = element(doc, 'select');
    for (const [value, copy] of [
      ['attention', 'Needs attention'], ['feature', 'Feature suite'], ['technical', 'Technical suite'],
      ['audit', 'Audit catalog'], ['capture-time', 'Capture time'],
    ]) {
      const option = element(doc, 'option', null, copy);
      option.value = value;
      option.selected = state.query.sort === value;
      sortSelect.append(option);
    }
    sortSelect.value = state.query.sort;
    sortSelect.dataset.focusKey = 'gallery-sort';
    sortSelect.addEventListener('change', () => void setQuery({ sort: sortSelect.value }));
    sortLabel.append(sortSelect);
    filters.append(sortLabel);
    const searchLabel = element(doc, 'label', 'gallery-filter gallery-search');
    searchLabel.append(element(doc, 'span', null, 'Search tests'));
    const search = element(doc, 'input');
    search.type = 'search';
    search.dataset.focusKey = 'gallery-search';
    search.value = state.query.search;
    search.maxLength = 1_200;
    search.addEventListener('change', () => void setQuery({ search: search.value }));
    searchLabel.append(search);
    filters.append(searchLabel);
    filters.append(button(doc, 'Clear filters', 'clear-filters', () => void setQuery({
      ...EMPTY_QUERY,
      group: state.query.group,
      sort: state.query.sort,
    })));
    if (compact) filters.append(button(doc, 'Close filters', 'close-filters', () => {
      const focusKey = state.layers.focusHistory.at(-1);
      dispatch({ type: 'CLOSE_LAYER', layer: 'responsivePanel' });
      restoreFocus(focusKey);
    }));
    controlsRegion.append(filters);
  }

  function renderQueue() {
    if (typeof presentation?.renderQueue === 'function') {
      presentation.renderQueue(renderContextForPresentation());
      return;
    }
    queueRegion.hidden = state.mode !== 'workbench';
    viewerColumn.hidden = state.mode !== 'workbench';
    if (state.mode !== 'workbench') {
      queueRegion.replaceChildren();
      renderedQueueItems = null;
      return;
    }
    const currentViewport = viewportMode();
    if (renderedQueueItems === state.accepted.items
      && renderedQueueGroup === state.query.group
      && renderedQueueViewport === currentViewport) {
      let selectedVisible = false;
      for (const child of queueRegion.children) {
        if (!child.dataset?.itemId) continue;
        const selected = child.dataset.itemId === state.selection.itemId;
        child.setAttribute('aria-current', selected ? 'true' : 'false');
        selectedVisible ||= selected;
      }
      // Keep the mounted bounded window while the selection remains inside it.
      // This prevents 60 buttons and their headings from being recreated on
      // every arrow press without hiding the current item from the reviewer.
      if (selectedVisible) return;
    }
    queueRegion.replaceChildren();
    renderedQueueItems = state.accepted.items;
    renderedQueueGroup = state.query.group;
    renderedQueueViewport = currentViewport;
    const heading = element(doc, 'h2', null, state.query.group === 'technical' ? 'Technical test queue' : 'Feature test queue');
    heading.tabIndex = -1;
    heading.dataset.focusKey = 'queue-heading';
    queueRegion.append(heading);
    if (viewportMode() !== 'desktop') queueRegion.append(button(doc, 'Close test queue', 'close-queue', () => {
      const focusKey = state.layers.focusHistory.at(-1);
      dispatch({ type: 'CLOSE_LAYER', layer: 'responsivePanel' });
      restoreFocus(focusKey);
    }));
    const selectedIndex = Math.max(0, state.accepted.items.findIndex(({ id }) => id === state.selection.itemId));
    const queueStart = Math.max(0, Math.min(
      selectedIndex - Math.floor(GALLERY_LIMITS.queueItems / 2),
      state.accepted.items.length - GALLERY_LIMITS.queueItems,
    ));
    const items = state.accepted.items.slice(queueStart, queueStart + GALLERY_LIMITS.queueItems);
    let priorSuite = null;
    let priorGroup = null;
    for (const row of items) {
      const suite = state.query.group === 'technical' ? row.technicalSuite : state.query.group === 'none' ? null : row.primaryFeatureSuite;
      if (suite !== priorSuite) {
        const suiteHeading = element(doc, 'h3', 'gallery-suite-label');
        suiteHeading.append(bdi(doc, suite ?? 'Ungrouped evidence'));
        queueRegion.append(suiteHeading);
        priorSuite = suite;
        priorGroup = null;
      }
      if (row.testGroupId !== priorGroup) {
        const label = element(doc, 'h4', 'gallery-test-label');
        label.append(bdi(doc, row.testLabel));
        queueRegion.append(label);
        priorGroup = row.testGroupId;
      }
      const choice = button(doc, `${row.kind === 'video' ? 'Video' : 'Photo'} · ${row.status}`, 'select-item', () => void selectItem(row.id));
      choice.dataset.itemId = row.id;
      choice.dataset.focusKey = `queue-${row.id}`;
      choice.setAttribute('aria-current', row.id === state.selection.itemId ? 'true' : 'false');
      choice.addEventListener('click', () => {
        if (state.layers.responsivePanel === 'queue') dispatch({ type: 'CLOSE_LAYER', layer: 'responsivePanel' });
      });
      queueRegion.append(choice);
    }
  }

  function renderViewer() {
    clearVideo(activeVideo);
    activeVideo = null;
    viewerRegion.replaceChildren();
    if (typeof presentation?.renderViewer === 'function') {
      presentation.renderViewer(renderContextForPresentation());
      return;
    }
    const row = selectSelectedRow(state);
    if (!row) {
      viewerRegion.append(element(doc, 'p', 'gallery-empty', selectAsyncState(state).title));
      return;
    }
    const title = element(doc, 'h2', null);
    title.append(bdi(doc, row.title));
    viewerRegion.append(title);
    if (state.media.status === 'loading') viewerRegion.append(element(doc, 'div', 'gallery-loader', 'Loading selected evidence…'));
    else if (state.media.status === 'error' || state.availability?.state === 'tombstone') {
      const unavailable = element(doc, 'section', 'gallery-media-error');
      unavailable.append(
        element(doc, 'strong', null, 'Evidence unavailable'),
        bdi(doc, state.media.error ?? state.availability?.message ?? 'The test context remains available.'),
        button(doc, 'Retry member', 'retry-media', () => void retrySelectedMedia()),
        button(doc, 'Skip to next', 'skip-media', () => void navigate(1)),
      );
      viewerRegion.append(unavailable);
    } else if (['resolved', 'ready'].includes(state.media.status) && state.media.source) {
      const selectedItemId = state.selection.itemId;
      const selectedMemberId = state.selection.memberId;
      const reportMediaFailure = (copy) => dispatch({
        type: 'MEDIA_ELEMENT_FAILED', itemId: selectedItemId, memberId: selectedMemberId, error: copy,
      });
      if (row.kind === 'video') {
        if (state.media.source.posterUrl) {
          const posterProbe = element(doc, 'img', 'gallery-video-poster-probe');
          posterProbe.alt = '';
          posterProbe.hidden = true;
          posterProbe.src = state.media.source.posterUrl;
          posterProbe.addEventListener('error', () => dispatch({
            type: 'POSTER_ELEMENT_FAILED', itemId: selectedItemId, memberId: selectedMemberId,
          }));
          viewerRegion.append(posterProbe);
        }
        const video = element(doc, 'video', 'gallery-selected-video');
        video.controls = true;
        video.preload = 'metadata';
        video.src = state.media.source.url;
        if (state.media.source.posterUrl) video.poster = state.media.source.posterUrl;
        const playback = state.playback[state.selection.memberId] ?? { time: 0, paused: true };
        video.currentTime = playback.time;
        video.addEventListener('loadedmetadata', () => {
          viewerRegion.querySelector?.('.gallery-loader')?.remove?.();
          dispatch({ type: 'MEDIA_ELEMENT_LOADED', itemId: selectedItemId, memberId: selectedMemberId });
        });
        video.addEventListener('timeupdate', () => dispatch({
          type: 'SET_PLAYBACK', memberId: selectedMemberId, time: video.currentTime, paused: video.paused,
        }));
        video.addEventListener('error', () => reportMediaFailure('The selected video or byte range could not be loaded.'));
        activeVideo = video;
        viewerRegion.append(video);
      } else {
        const image = element(doc, 'img', 'gallery-selected-image');
        image.alt = `${row.title} visual evidence`;
        image.src = state.media.source.url;
        image.addEventListener('load', () => {
          viewerRegion.querySelector?.('.gallery-loader')?.remove?.();
          dispatch({ type: 'MEDIA_ELEMENT_LOADED', itemId: selectedItemId, memberId: selectedMemberId });
        });
        image.addEventListener('error', () => reportMediaFailure('The selected image could not be loaded.'));
        viewerRegion.append(image);
      }
    } else viewerRegion.append(element(doc, 'div', 'gallery-loader', 'Preparing selected evidence…'));
    if (state.media.status === 'resolved') viewerRegion.append(element(doc, 'div', 'gallery-loader', 'Loading media bytes…'));
    if (state.media.posterError) viewerRegion.append(element(doc, 'p', 'gallery-media-warning', state.media.posterError));
    const member = selectSelectedMember(state);
    if (member) viewerRegion.append(element(doc, 'p', 'gallery-member-label', `${member.role} · ${member.name}`));
  }

  function renderFilmstrip() {
    if (typeof presentation?.renderFilmstrip === 'function') {
      presentation.renderFilmstrip(renderContextForPresentation());
      return;
    }
    if (state.mode !== 'workbench') {
      filmstripRegion.replaceChildren();
      renderedFilmstripItems = null;
      renderedFilmstripIds = [];
      return;
    }
    const visibleRows = renderedFilmstripIds.map((id) => state.accepted.items.find((row) => row.id === id)).filter(Boolean);
    const thumbnailSignature = visibleRows.map((row) => `${row.id}:${state.thumbnails[row.id] ?? ''}`).join('\0');
    if (renderedFilmstripItems === state.accepted.items
      && renderedFilmstripResolutionEnabled === thumbnailResolutionEnabled
      && renderedFilmstripIds.includes(state.selection.itemId)
      && renderedFilmstripThumbnails === thumbnailSignature) {
      for (const child of filmstripRegion.children) {
        if (!child.dataset?.itemId) continue;
        child.setAttribute('aria-current', child.dataset.itemId === state.selection.itemId ? 'true' : 'false');
      }
      return;
    }
    filmstripRegion.replaceChildren();
    filmstripRegion.setAttribute('aria-label', 'Nearby visual evidence');
    const rows = selectLocalFilmstrip(state);
    renderedFilmstripItems = state.accepted.items;
    renderedFilmstripIds = rows.map(({ id }) => id);
    renderedFilmstripResolutionEnabled = thumbnailResolutionEnabled;
    renderedFilmstripThumbnails = rows.map((row) => `${row.id}:${state.thumbnails[row.id] ?? ''}`).join('\0');
    for (const row of rows) {
      const choice = button(doc, '', 'filmstrip-select', () => void selectItem(row.id));
      choice.dataset.itemId = row.id;
      choice.setAttribute('aria-label', row.testLabel);
      choice.setAttribute('aria-current', row.id === state.selection.itemId ? 'true' : 'false');
      const thumbnail = state.thumbnails[row.id];
      if (row.kind === 'image' && thumbnail) {
        const image = element(doc, 'img', 'gallery-filmstrip-image');
        image.alt = '';
        image.src = thumbnail;
        choice.append(image);
      } else {
        choice.append(element(doc, 'span', null, row.kind === 'video' ? 'Video' : 'Photo'));
        if (row.kind === 'image' && thumbnailResolutionEnabled) resolveThumbnail(row);
      }
      filmstripRegion.append(choice);
    }
  }

  function appendContextPair(list, label, value) {
    const term = element(doc, 'dt', null, label);
    const description = element(doc, 'dd');
    description.append(bdi(doc, value ?? 'Not recorded'));
    list.append(term, description);
  }

  function renderContext() {
    if (typeof presentation?.renderContext === 'function') {
      presentation.renderContext(renderContextForPresentation());
      return;
    }
    contextRegion.replaceChildren();
    contextRegion.hidden = state.mode !== 'workbench' || !state.layers.context;
    if (contextRegion.hidden) return;
    const heading = element(doc, 'h2', null, 'Test context');
    heading.tabIndex = -1;
    heading.dataset.focusKey = 'context-heading';
    contextRegion.append(heading);
    if (viewportMode() !== 'desktop') contextRegion.append(button(doc, 'Close test context', 'close-context', () => {
      const focusKey = state.layers.focusHistory.at(-1);
      dispatch({ type: 'CLOSE_LAYER', layer: 'responsivePanel' });
      restoreFocus(focusKey);
    }));
    const detail = state.detail;
    const row = selectSelectedRow(state);
    if (!row) {
      contextRegion.append(element(doc, 'p', 'gallery-empty', selectAsyncState(state).title));
      return;
    }
    if (!detail) {
      contextRegion.append(element(doc, 'div', 'gallery-loader', 'Loading test context…'));
      return;
    }
    const list = element(doc, 'dl', 'gallery-context-list');
    appendContextPair(list, 'Audit', detail.item.auditAssociations.map(({ id, title }) => `${id}: ${title}`).join('; '));
    appendContextPair(list, 'Expected', detail.item.auditAssociations.map(({ expected }) => expected).join('; '));
    appendContextPair(list, 'Observed', detail.item.capture.observedState);
    appendContextPair(list, 'Reviewed outcome', detail.item.attempt.status);
    appendContextPair(list, 'Raw browser result', detail.item.attempt.rawStatus);
    appendContextPair(list, 'Status authority', detail.item.attempt.statusSource === 'reviewed-manifest'
      ? 'Structured audit review'
      : detail.item.attempt.statusSource === 'release-integrity'
        ? 'Release integrity review'
        : 'Live browser result (provisional)');
    appendContextPair(list, 'Review reason codes', detail.item.attempt.reviewReasonCodes.join(', ') || null);
    appendContextPair(list, 'Environment', detail.item.project.environment);
    appendContextPair(list, 'Route', detail.item.capture.route);
    appendContextPair(list, 'Browser / project', `${detail.item.project.browser} / ${detail.item.project.name}`);
    appendContextPair(list, 'Device', detail.item.project.deviceClass);
    appendContextPair(list, 'Viewport', detail.item.capture.viewport ? `${detail.item.capture.viewport.width} × ${detail.item.capture.viewport.height}` : null);
    appendContextPair(list, 'Attempt', `${detail.item.attempt.ordinal}; retry ${detail.item.attempt.retry}`);
    appendContextPair(list, 'Capture rationale', detail.item.capture.rationale);
    appendContextPair(list, 'Captured', detail.item.capture.capturedAt);
    contextRegion.append(list);
    const review = element(doc, 'section', 'gallery-review-state');
    review.append(element(doc, 'h3', null, 'Reviewer flags'));
    if (detail.review.flags.length === 0) review.append(element(doc, 'p', null, 'No reviewer flag is attached to this evidence.'));
    else for (const flag of detail.review.flags.slice(0, 20)) {
      const flagCopy = element(doc, 'p');
      flagCopy.append(bdi(doc, `${flag.state ?? 'flagged'} · ${flag.reviewer ?? 'Reviewer'} · ${flag.note ?? flag.justification ?? ''}`));
      review.append(flagCopy);
    }
    if (state.capability.flagsMutable) review.append(button(doc, 'Flag visual issue', 'open-flag', () => options.onFlagIntent?.(state.selection.itemId)));
    else review.append(element(doc, 'p', 'gallery-read-only', 'Reviewer flags are read-only here.'));
    contextRegion.append(review);
  }

  function renderOverview() {
    if (typeof presentation?.renderOverview === 'function') {
      presentation.renderOverview(renderContextForPresentation());
      return;
    }
    overviewRegion.replaceChildren();
    overviewRegion.hidden = state.mode !== 'overview';
    if (overviewRegion.hidden) return;
    const heading = element(doc, 'h2', null, 'Visual overview');
    overviewRegion.append(heading);
    const grid = element(doc, 'div', 'gallery-overview-grid');
    const selectedIndex = Math.max(0, state.accepted.items.findIndex(({ id }) => id === state.selection.itemId));
    const overviewStart = Math.max(0, Math.min(
      selectedIndex - Math.floor(GALLERY_LIMITS.overviewItems / 2),
      state.accepted.items.length - GALLERY_LIMITS.overviewItems,
    ));
    const items = state.accepted.items.slice(overviewStart, overviewStart + GALLERY_LIMITS.overviewItems);
    activeOverviewObserver?.disconnect?.();
    activeOverviewObserver = null;
    const observer = typeof options.observerFactory === 'function'
      ? options.observerFactory((entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const row = items.find(({ id }) => id === entry.target.dataset.itemId);
            if (row?.kind === 'image') resolveThumbnail(row);
            observer?.unobserve?.(entry.target);
          }
        })
      : null;
    activeOverviewObserver = observer;
    for (const row of items) {
      const card = button(doc, '', 'overview-select', () => {
        abort('detail');
        abort('availability');
        abort('media');
        dispatch({
          type: 'SELECT_ITEM', itemId: row.id, forceHistory: true,
          historyItemId: row.id, historyFocusKey: `overview-${row.id}`,
        });
        dispatch({ type: 'SET_MODE', mode: 'workbench' });
        void loadSelected();
      });
      card.dataset.itemId = row.id;
      card.dataset.focusKey = `overview-${row.id}`;
      const thumbnail = state.thumbnails[row.id];
      if (row.kind === 'image') {
        const image = element(doc, 'img', 'gallery-overview-image');
        image.alt = '';
        image.dataset.itemId = row.id;
        if (thumbnail) image.src = thumbnail;
        else if (thumbnailResolutionEnabled) observer?.observe?.(image);
        card.append(image);
      } else card.append(element(doc, 'span', 'gallery-video-placeholder', 'Video · metadata loads only when selected'));
      const label = element(doc, 'span', 'gallery-overview-label');
      label.append(bdi(doc, row.testLabel));
      card.append(label);
      grid.append(card);
    }
    overviewRegion.append(grid);
    if (state.accepted.nextCursor) overviewRegion.append(button(doc, 'Load more evidence', 'overview-load-more', () => {
      void loadSequence({ append: true, restoreAnchor: false });
    }));
  }

  function renderHelp() {
    const existing = shell.querySelector?.('[data-gallery-help]');
    existing?.remove?.();
    if (!state.layers.help) return;
    const dialog = element(doc, 'dialog', 'gallery-help');
    dialog.dataset.galleryHelp = 'true';
    dialog.dataset.galleryShortcuts = 'owned';
    dialog.setAttribute('aria-labelledby', 'gallery-help-title');
    const heading = element(doc, 'h2', null, 'Gallery keyboard shortcuts');
    heading.id = 'gallery-help-title';
    heading.tabIndex = -1;
    const list = element(doc, 'ul');
    for (const copy of [
      'Left / Right: previous or next evidence item',
      'Up / Down: previous or next test group',
      '[ / ]: previous or next comparison member',
      'Space: play or pause the selected video when the viewer owns focus',
      'I: toggle test context',
      'F: enter or leave fullscreen',
      'Escape: close one gallery layer',
      '?: open this shortcut help',
    ]) list.append(element(doc, 'li', null, copy));
    dialog.append(heading, list, button(doc, 'Close shortcuts', 'close-help', () => {
      const focusKey = state.layers.focusHistory.at(-1);
      dispatch({ type: 'CLOSE_LAYER', layer: 'help' });
      restoreFocus(focusKey);
    }));
    const closeDialog = (event) => {
      if (event.type === 'keydown' && event.key !== 'Escape') return;
      event.preventDefault?.();
      event.stopPropagation?.();
      const focusKey = state.layers.focusHistory.at(-1);
      dispatch({ type: 'CLOSE_LAYER', layer: 'help' });
      restoreFocus(focusKey);
    };
    dialog.addEventListener('keydown', closeDialog);
    dialog.addEventListener('cancel', closeDialog);
    shell.append(dialog);
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.open = true;
    scheduler(() => heading.focus?.());
  }

  function render(targets = new Set(['status', 'controls', 'queue', 'viewer', 'filmstrip', 'context', 'overview', 'help'])) {
    shell.dataset.responsivePanel = state.layers.responsivePanel ?? 'none';
    if (targets.has('status')) renderStatus();
    if (targets.has('controls')) renderControls();
    if (targets.has('queue')) renderQueue();
    if (targets.has('viewer')) renderViewer();
    if (targets.has('filmstrip')) renderFilmstrip();
    if (targets.has('context')) renderContext();
    if (targets.has('overview')) renderOverview();
    if (targets.has('help')) renderHelp();
    if (!firstUsableEmitted && state.accepted.items.length > 0 && state.detail
      && ['resolved', 'ready', 'error'].includes(state.media.status)) {
      firstUsableEmitted = true;
      options.onFirstUsable?.({ itemId: state.selection.itemId, state });
      scheduler(() => {
        if (destroyed) return;
        thumbnailResolutionEnabled = true;
        render(new Set(['filmstrip', 'overview']));
      });
    }
  }

  render();

  return Object.freeze({
    initialize,
    loadHead,
    loadSequence,
    loadSelected,
    resolveSelectedMedia,
    probeSelectedAvailability,
    applyPendingRevision,
    setQuery,
    selectItem,
    selectMember,
    selectMemberById,
    navigate,
    mutateFlag,
    dispatch,
    getState: () => state,
    subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); },
    destroy() {
      destroyed = true;
      thumbnailPumpGeneration += 1;
      thumbnailQueue.length = 0;
      cancelThumbnailSchedule();
      for (const slot of REQUEST_SLOTS) abort(slot);
      activeOverviewObserver?.disconnect?.();
      clearVideo(activeVideo);
      shell.removeEventListener('keydown', onKeydown);
      doc.defaultView?.removeEventListener?.('resize', onViewportResize);
      root.replaceChildren();
      subscribers.clear();
    },
  });
}

const SINGLE_SITE_VISUAL_STATES = new Set([
  'CHANGED', 'UNCHANGED', 'REVIEWED', 'absent', 'incompatible', 'unavailable',
]);

function singleSiteText(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function singleSiteBoolean(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

/** Normalize the compact server row/detail used by the Single-site gallery. */
export function normalizeSingleSiteGalleryItem(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const itemId = singleSiteText(value.itemId ?? value.id);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(itemId)) return null;
  const comparison = value.comparison && typeof value.comparison === 'object' ? value.comparison : {};
  const review = comparison.review && typeof comparison.review === 'object' ? comparison.review : null;
  const rawVisualStatus = review?.status === 'REVIEWED' ? 'REVIEWED' : singleSiteText(
    value.visualReviewStatus ?? value.visualStatus ?? comparison.status,
    'unavailable',
  );
  const visualStatus = SINGLE_SITE_VISUAL_STATES.has(rawVisualStatus) ? rawVisualStatus : 'unavailable';
  const findingCount = Number.isInteger(value.findingCount)
    ? Math.max(0, value.findingCount)
    : Array.isArray(value.findings) ? value.findings.length
      : value.findingStatus === 'unresolved' ? 1 : 0;
  const kind = value.kind === 'video' ? 'video' : 'image';
  const identity = value.identity && typeof value.identity === 'object' ? value.identity : {};
  const urls = value.urls && typeof value.urls === 'object' ? value.urls : {};
  return Object.freeze({
    ...value,
    itemId,
    kind,
    title: singleSiteText(value.title, singleSiteText(value.auditTitle, singleSiteText(value.auditId, itemId))),
    suite: singleSiteText(value.suite, singleSiteText(value.featureSuite, singleSiteText(value.area, 'Uncategorized'))),
    auditId: singleSiteText(value.auditId, singleSiteText(identity.auditId, 'Unknown audit')),
    caseId: singleSiteText(value.caseId, 'Unknown case'),
    targetId: singleSiteText(value.targetId, singleSiteText(identity.targetId, 'Unknown target')),
    route: singleSiteText(value.route, singleSiteText(identity.route, 'Unknown route')),
    capturePoint: singleSiteText(value.capturePoint, singleSiteText(identity.capturePoint, 'Unnamed state')),
    theme: singleSiteText(value.theme, singleSiteText(identity.theme, 'default')),
    severity: ['P0', 'P1', 'P2', 'P3'].includes(value.severity) ? value.severity : 'P3',
    findingCount,
    findingStatus: findingCount > 0 ? 'unresolved' : 'clear',
    coverageGap: singleSiteBoolean(value.coverageGap, value.coverageStatus === 'gap'),
    visualStatus,
    comparison,
    identity,
    evidence: value.evidence && typeof value.evidence === 'object' ? value.evidence : null,
    evidenceId: singleSiteText(value.evidenceId, null),
    eligible: singleSiteBoolean(value.eligible, false),
    ineligibilityReasons: Array.isArray(value.ineligibilityReasons)
      ? value.ineligibilityReasons.filter((reason) => typeof reason === 'string').slice(0, 50)
      : [],
    baseline: value.baseline && typeof value.baseline === 'object' ? value.baseline : null,
    media: Object.freeze({
      current: singleSiteText(urls.current ?? value.current?.url, null),
      baseline: singleSiteText(urls.baseline ?? value.baseline?.url ?? value.baseline?.mediaUrl, null),
      diff: singleSiteText(urls.diff ?? value.diff?.url, null),
      poster: singleSiteText(urls.poster ?? value.poster?.url, null),
    }),
  });
}

export function isSingleSiteAttentionItem(item) {
  return Boolean(item && (
    item.findingCount > 0
    || item.coverageGap
    || ['CHANGED', 'unavailable', 'incompatible'].includes(item.visualStatus)
  ));
}

export function compareSingleSiteAttention(left, right) {
  const severity = { P0: 0, P1: 1, P2: 2, P3: 3 };
  const rank = (item) => [
    item.findingCount > 0 ? 0 : 1,
    severity[item.severity] ?? 4,
    item.visualStatus === 'CHANGED' ? 0 : 1,
    item.coverageGap ? 0 : 1,
    item.suite,
    item.auditId,
    item.caseId,
    item.itemId,
  ];
  const a = rank(left);
  const b = rank(right);
  for (let index = 0; index < a.length; index += 1) {
    const compared = typeof a[index] === 'number'
      ? a[index] - b[index]
      : String(a[index]).localeCompare(String(b[index]));
    if (compared) return compared;
  }
  return 0;
}

export function filterSingleSiteGalleryItems(items, filters = {}) {
  const scope = filters.scope === 'all' ? 'all' : 'attention';
  const query = singleSiteText(filters.query).toLocaleLowerCase();
  return (Array.isArray(items) ? items : [])
    .map(normalizeSingleSiteGalleryItem)
    .filter(Boolean)
    .filter((item) => scope === 'all' || isSingleSiteAttentionItem(item))
    .filter((item) => !filters.kind || item.kind === filters.kind)
    .filter((item) => !filters.suite || item.suite === filters.suite)
    .filter((item) => !filters.finding || filters.finding === 'all'
      || (filters.finding === 'finding' ? item.findingCount > 0 : item.findingCount === 0))
    .filter((item) => !filters.coverage || filters.coverage === 'all'
      || (filters.coverage === 'gap' ? item.coverageGap : !item.coverageGap))
    .filter((item) => !filters.visual || filters.visual === 'all' || item.visualStatus === filters.visual)
    .filter((item) => !query || [item.title, item.auditId, item.caseId, item.suite, item.route, item.capturePoint, item.targetId]
      .some((field) => field.toLocaleLowerCase().includes(query)))
    .sort(scope === 'attention' ? compareSingleSiteAttention : (left, right) => (
      left.suite.localeCompare(right.suite)
      || left.auditId.localeCompare(right.auditId)
      || left.caseId.localeCompare(right.caseId)
      || left.itemId.localeCompare(right.itemId)
    ));
}

const SINGLE_SITE_DEFAULT_FILTERS = Object.freeze({
  scope: 'attention', kind: '', suite: '', finding: 'all', coverage: 'all', visual: 'all', query: '',
});

function singleSiteInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function singleSiteNumber(fallback, value) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function singleSiteHumanize(value) {
  return String(value ?? '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function singleSiteVisualStatusCopy(status) {
  return {
    CHANGED: 'Material pixel differences require a human disposition.',
    UNCHANGED: 'No material difference was detected under the frozen comparison policy.',
    REVIEWED: 'A human disposition is recorded for this visual comparison.',
    absent: 'No compatible approved baseline exists; current evidence remains reviewable.',
    incompatible: 'A baseline exists, but its exact rendering identity is incompatible.',
    unavailable: 'The comparison could not be completed; deterministic audit truth is unchanged.',
  }[status] ?? 'Visual comparison state is unavailable.';
}

function singleSiteFilters(value = {}) {
  const filters = { ...SINGLE_SITE_DEFAULT_FILTERS, ...(value && typeof value === 'object' ? value : {}) };
  filters.scope = filters.scope === 'all' ? 'all' : 'attention';
  filters.kind = ['image', 'video'].includes(filters.kind) ? filters.kind : '';
  filters.suite = singleSiteText(filters.suite);
  filters.finding = ['all', 'finding', 'clear'].includes(filters.finding) ? filters.finding : 'all';
  filters.coverage = ['all', 'gap', 'covered'].includes(filters.coverage) ? filters.coverage : 'all';
  filters.visual = ['all', ...SINGLE_SITE_VISUAL_STATES].includes(filters.visual) ? filters.visual : 'all';
  filters.query = singleSiteText(filters.query).slice(0, 1_200);
  return Object.freeze(filters);
}

function singleSiteQuery(filters) {
  const value = singleSiteFilters(filters);
  return {
    kinds: value.kind ? [value.kind] : [],
    featureSuites: value.suite ? [value.suite] : [],
    statuses: [`scope:${value.scope}`, `finding:${value.finding}`, `coverage:${value.coverage}`, `visual:${value.visual}`],
    search: value.query,
    group: 'feature',
    sort: value.scope === 'attention' ? 'attention' : 'feature',
  };
}

function singleSiteFiltersFromQuery(query) {
  const encoded = Object.fromEntries((query?.statuses ?? []).map((entry) => {
    const boundary = entry.indexOf(':');
    return boundary > 0 ? [entry.slice(0, boundary), entry.slice(boundary + 1)] : ['', ''];
  }));
  return singleSiteFilters({
    scope: encoded.scope,
    kind: query?.kinds?.[0] ?? '',
    suite: query?.featureSuites?.[0] ?? '',
    finding: encoded.finding,
    coverage: encoded.coverage,
    visual: encoded.visual,
    query: query?.search ?? '',
  });
}

function singleSiteHash(value) {
  let hash = 0xcbf29ce484222325n;
  for (const character of String(value)) {
    hash ^= BigInt(character.codePointAt(0));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

function singleSiteCoreItemId(itemId) {
  return /^gitem_[a-f0-9]{16}$/.test(itemId) ? itemId : `gitem_${singleSiteHash(itemId)}`;
}

function singleSiteCoreRow(item) {
  return {
    id: singleSiteCoreItemId(item.itemId),
    testGroupId: `gtest_${singleSiteHash(`suite:${item.suite}`)}`,
    kind: item.kind,
    title: item.title,
    testLabel: `${item.auditId} · ${item.caseId} · ${item.title}`,
    testTitlePath: [item.suite, item.auditId, item.title],
    projectName: item.targetId,
    status: item.findingCount > 0 ? `${item.findingCount} unresolved finding${item.findingCount === 1 ? '' : 's'}` : singleSiteHumanize(item.visualStatus),
    environment: 'single-site',
    featureSuites: [item.suite],
    primaryFeatureSuite: item.suite,
    primaryAuditCatalogOrdinal: null,
    technicalSuite: item.auditId,
    targets: [item.targetId],
    flagState: 'unflagged',
    attempt: { ordinal: 1, retry: 0 },
    captureTime: null,
    available: Boolean(item.media.current || item.evidence || item.current),
    visualWarning: isSingleSiteAttentionItem(item),
    auditAssociations: [{ id: item.auditId, title: item.title, catalogOrdinal: null }],
  };
}

function singleSiteMemberId(coreItemId, view) {
  return `single_${singleSiteHash(`${coreItemId}:${view}`)}`;
}

function singleSiteCoreDetail(item) {
  const coreItemId = singleSiteCoreItemId(item.itemId);
  const members = ['current', 'baseline', 'diff'].map((view) => ({
    id: singleSiteMemberId(coreItemId, view),
    name: view === 'current' ? 'Current' : view === 'baseline' ? 'Approved baseline' : 'Difference',
    role: view === 'current' ? 'actual' : view,
    contentType: item.kind === 'video' && view === 'current' ? 'video/webm' : 'image/png',
    available: Boolean(item.media[view]),
    error: item.media[view] ? null : `${singleSiteHumanize(view)} media is unavailable.`,
  }));
  return {
    schemaVersion: 1,
    item: {
      id: coreItemId,
      kind: item.kind,
      test: {
        id: singleSiteText(item.testContext?.testId, item.caseId),
        title: item.title,
        titlePath: [item.suite, item.auditId, item.title],
        file: singleSiteText(item.testContext?.file),
        technicalSuite: item.auditId,
      },
      attempt: {
        ordinal: 1,
        retry: 0,
        status: item.findingCount > 0 ? 'failed' : 'passed',
        rawStatus: item.findingCount > 0 ? 'failed' : 'passed',
        statusSource: 'reviewed-manifest',
        reviewReasonCodes: [],
        expectedStatus: 'passed',
        startedAt: null,
        durationMs: 0,
      },
      project: { name: item.targetId, environment: 'single-site', browser: item.targetId, deviceClass: item.targetId },
      auditAssociations: [{
        id: item.auditId, title: item.title,
        expected: singleSiteText(item.testContext?.expected, 'The audited state meets its documented acceptance criteria.'),
        featureSuite: item.suite, catalogOrdinal: null,
      }],
      members,
      comparison: { key: `${item.itemId}:${item.visualStatus}`, complete: Boolean(item.media.baseline && item.media.diff) },
      capture: {
        route: item.route,
        observedState: singleSiteText(item.testContext?.observed, item.comparison?.reason ?? singleSiteVisualStatusCopy(item.visualStatus)),
        rationale: singleSiteText(item.testContext?.rationale, 'Review the published visual evidence and deterministic audit context together.'),
        capturedAt: singleSiteText(item.capturedAt, null),
        viewport: item.viewport && Number.isInteger(item.viewport.width) && Number.isInteger(item.viewport.height) ? item.viewport : null,
      },
    },
    media: members.map((member, index) => {
      const view = ['current', 'baseline', 'diff'][index];
      return { memberId: member.id, href: item.media[view], contentType: member.contentType, available: member.available };
    }),
    availability: { state: item.media.current ? 'available' : 'tombstone', retryable: true, message: item.media.current ? null : 'Current media is unavailable.' },
    review: { flagRevision: null, flags: [] },
  };
}

function singleSiteRevision(head) {
  return `${head?.publicationRevision ?? ''}:${singleSiteInteger(head?.baselineStoreRevision ?? head?.storeRevision) ?? ''}:${singleSiteInteger(head?.reviewRevision) ?? ''}`;
}

function singleSiteHeadForCore(head) {
  const counts = head?.primaryCounts ?? head?.summary ?? {};
  return {
    ...head,
    phase: ['waiting', 'live', 'sealed'].includes(head?.phase) ? head.phase : 'sealed',
    contentRevision: String(head?.publicationRevision ?? head?.contentRevision ?? ''),
    orderRevision: singleSiteRevision(head),
    flagRevision: String(singleSiteInteger(head?.reviewRevision) ?? ''),
    primaryCounts: { total: singleSiteNumber(0, counts.total), images: singleSiteNumber(0, counts.images), videos: singleSiteNumber(0, counts.videos) },
    facets: { featureSuites: Array.isArray(head?.facets?.suites) ? head.facets.suites : [] },
  };
}

function singleSiteAppendContextPair(doc, list, label, value) {
  list.append(element(doc, 'dt', null, label), element(doc, 'dd', null, String(value ?? 'Not recorded')));
}

/**
 * Single-site is a transport/presentation adapter over createGalleryWorkbench.
 * The shared controller exclusively owns reducer state, request generations,
 * cancellation, stale-result suppression, selection, focus, and keyboard intent.
 */
export function createSingleSiteGalleryWorkbench(root, options = {}) {
  if (!root?.ownerDocument) throw new TypeError('A Single-site gallery root element is required.');
  const dataSource = options.dataSource;
  if (!dataSource || typeof dataSource.loadHead !== 'function'
    || typeof dataSource.loadItems !== 'function' || typeof dataSource.loadItem !== 'function') {
    throw new TypeError('A complete Single-site gallery data source is required.');
  }
  const rawByCoreId = new Map();
  const coreByRawId = new Map();
  const details = new Map();
  const facadeSubscribers = new Set();
  let rawHead = null;
  let rawPage = null;
  let destroyed = false;
  let lastStatusKey = '';
  let renderedComparison = null;
  const initialFilters = singleSiteFilters(options.initialState?.filters);
  const initialRawId = typeof options.initialState?.selectedId === 'string' ? options.initialState.selectedId : null;
  if (initialRawId) coreByRawId.set(initialRawId, singleSiteCoreItemId(initialRawId));

  const remember = (item) => {
    const normalized = normalizeSingleSiteGalleryItem(item);
    if (!normalized) return null;
    const coreId = singleSiteCoreItemId(normalized.itemId);
    rawByCoreId.set(coreId, normalized);
    coreByRawId.set(normalized.itemId, coreId);
    return normalized;
  };
  const selectedRaw = (state) => details.get(state.selection.itemId) ?? rawByCoreId.get(state.selection.itemId) ?? null;
  const visibleRows = (state) => {
    const filters = singleSiteFiltersFromQuery(state.query);
    return filterSingleSiteGalleryItems(
      state.accepted.items.map(({ id }) => rawByCoreId.get(id)).filter(Boolean), filters,
    ).map(({ itemId }) => state.accepted.items.find(({ id }) => id === coreByRawId.get(itemId))).filter(Boolean);
  };
  const facadeState = (state = core.getState()) => {
    const filters = singleSiteFiltersFromQuery(state.query);
    const items = state.accepted.items.map(({ id }) => rawByCoreId.get(id)).filter(Boolean);
    const visible = visibleRows(state).map(({ id }) => rawByCoreId.get(id)).filter(Boolean);
    const selected = selectedRaw(state);
    return Object.freeze({
      mode: 'single-site', head: rawHead, page: rawPage,
      items: Object.freeze(items), visible: Object.freeze(visible),
      selectedId: selected?.itemId ?? initialRawId, selected,
      selectedExcluded: Boolean(selected && !visible.some(({ itemId }) => itemId === selected.itemId)),
      filters, offsetHistory: Object.freeze([]),
      storeRevision: singleSiteInteger(rawHead?.baselineStoreRevision ?? rawHead?.storeRevision),
      reviewRevision: singleSiteInteger(rawHead?.reviewRevision),
      view: state.detail?.item.members.find(({ id }) => id === state.selection.memberId)?.role === 'actual'
        ? 'current' : state.detail?.item.members.find(({ id }) => id === state.selection.memberId)?.role ?? 'current',
      requests: state.requests, destroyed,
    });
  };
  const updateComparisonSemantics = (wide) => {
    if (!renderedComparison) return;
    renderedComparison.tabs.setAttribute('role', wide ? 'group' : 'tablist');
    renderedComparison.tabs.setAttribute('aria-label', wide ? 'Visual comparison pane controls' : 'Visual comparison view');
    for (const { tab, pane, active, view } of renderedComparison.members) {
      if (wide) {
        tab.removeAttribute('role');
        tab.removeAttribute('aria-controls');
        tab.removeAttribute('aria-selected');
        tab.setAttribute('aria-pressed', active ? 'true' : 'false');
        pane.setAttribute('role', 'region');
        pane.setAttribute('aria-label', `${singleSiteHumanize(view)} visual pane`);
        pane.removeAttribute('aria-labelledby');
      } else {
        tab.removeAttribute('aria-pressed');
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-controls', `single-site-${view}-pane`);
        tab.setAttribute('aria-selected', active ? 'true' : 'false');
        pane.setAttribute('role', 'tabpanel');
        pane.setAttribute('aria-labelledby', tab.id);
        pane.removeAttribute('aria-label');
      }
    }
  };

  const presentation = {
    onViewportModeChange(context) {
      updateComparisonSemantics(context.viewportMode() === 'desktop');
    },
    selectNavigationTarget(state, direction, byTest) {
      const rows = visibleRows(state);
      if (rows.length === 0) return null;
      let index = rows.findIndex(({ id }) => id === state.selection.itemId);
      if (index < 0) {
        const sourceIndex = state.accepted.items.findIndex(({ id }) => id === state.selection.itemId);
        const candidates = direction < 0 ? [...rows].reverse() : rows;
        return candidates.find((row) => direction < 0
          ? state.accepted.items.indexOf(row) < sourceIndex
          : state.accepted.items.indexOf(row) > sourceIndex)?.id ?? null;
      }
      if (!byTest) return rows[index + direction]?.id ?? null;
      const group = rows[index].testGroupId;
      while (index >= 0 && index < rows.length && rows[index].testGroupId === group) index += direction;
      return rows[index]?.id ?? null;
    },
    renderStatus({ statusRegion }) { statusRegion.hidden = true; statusRegion.replaceChildren(); },
    renderControls(context) {
      const { doc, controlsRegion, state, setQuery } = context;
      const filters = singleSiteFiltersFromQuery(state.query);
      controlsRegion.replaceChildren();
      const scope = element(doc, 'div', 'single-site-review-scope');
      scope.setAttribute('role', 'group');
      scope.setAttribute('aria-label', 'Review scope');
      for (const [value, label] of [['attention', 'Needs attention'], ['all', 'Browse all evidence']]) {
        const action = button(doc, label, `single-site-scope-${value}`, () => void setQuery(singleSiteQuery({ ...filters, scope: value })));
        action.setAttribute('aria-pressed', filters.scope === value ? 'true' : 'false');
        scope.append(action);
      }
      const form = element(doc, 'form', 'single-site-filter-grid');
      form.setAttribute('role', 'search');
      form.addEventListener('submit', (event) => event.preventDefault());
      const facets = rawHead?.facets ?? {};
      for (const [labelText, key, choices] of [
        ['Evidence', 'kind', [['', 'Photos and videos'], ['image', 'Screenshots'], ['video', 'Videos']]],
        ['Suite', 'suite', [['', 'All suites'], ...(facets.suites ?? []).map((value) => [value, value])]],
        ['Findings', 'finding', [['all', 'All Finding states'], ['finding', 'Has Finding'], ['clear', 'No Finding']]],
        ['Coverage', 'coverage', [['all', 'All coverage states'], ['gap', 'Coverage gaps'], ['covered', 'Covered']]],
        ['Visual review', 'visual', [['all', 'All visual states'], ...[...SINGLE_SITE_VISUAL_STATES].map((value) => [value, singleSiteHumanize(value)])]],
      ]) {
        const label = element(doc, 'label', 'gallery-filter');
        label.append(element(doc, 'span', null, labelText));
        const select = element(doc, 'select');
        select.setAttribute('aria-label', labelText);
        for (const [value, copy] of choices) {
          const option = element(doc, 'option', null, copy);
          option.value = value;
          option.selected = filters[key] === value;
          select.append(option);
        }
        select.value = filters[key];
        select.addEventListener('change', () => void setQuery(singleSiteQuery({ ...filters, [key]: select.value })));
        label.append(select);
        form.append(label);
      }
      const searchLabel = element(doc, 'label', 'single-site-filter-search');
      searchLabel.append(element(doc, 'span', null, 'Find test context'));
      const search = element(doc, 'input');
      search.type = 'search'; search.maxLength = 1_200; search.value = filters.query;
      search.placeholder = 'Audit, route, target, or capture point';
      search.addEventListener('change', () => void setQuery(singleSiteQuery({ ...filters, query: search.value })));
      searchLabel.append(search);
      form.append(searchLabel, button(doc, 'Clear filters', 'single-site-clear-filters', () => void setQuery(singleSiteQuery({ scope: filters.scope }))));
      controlsRegion.append(scope, form);
    },
    renderQueue({ doc, queueRegion, viewerColumn, state, selectItem, loadSequence }) {
      queueRegion.hidden = false; viewerColumn.hidden = false; queueRegion.replaceChildren();
      const rows = visibleRows(state);
      const filters = singleSiteFiltersFromQuery(state.query);
      const heading = element(doc, 'div', 'single-site-queue-heading');
      heading.append(
        element(doc, 'h2', null, filters.scope === 'attention' ? 'Needs attention' : 'All evidence'),
        element(doc, 'span', 'muted', `${rows.length} shown · ${state.accepted.total} source items`),
      );
      queueRegion.append(heading);
      let suite = null;
      for (const row of rows.slice(0, GALLERY_LIMITS.queueItems)) {
        const item = rawByCoreId.get(row.id);
        if (!item) continue;
        if (suite !== item.suite) { suite = item.suite; queueRegion.append(element(doc, 'h3', 'gallery-suite-label', suite)); }
        const choice = button(doc, '', 'single-site-select-item', () => void selectItem(row.id));
        choice.className = 'single-site-queue-item';
        choice.dataset.itemId = row.id;
        choice.dataset.focusKey = `queue-${row.id}`;
        choice.setAttribute('aria-current', row.id === state.selection.itemId ? 'true' : 'false');
        choice.append(
          element(doc, 'strong', null, item.title),
          element(doc, 'span', null, `${item.kind === 'video' ? 'Video' : 'Screenshot'} · ${singleSiteHumanize(item.visualStatus)}${item.findingCount ? ` · ${item.findingCount} Finding${item.findingCount === 1 ? '' : 's'}` : ''}${item.coverageGap ? ' · Coverage gap' : ''}`),
        );
        queueRegion.append(choice);
      }
      if (rawPage) {
        const navigation = element(doc, 'nav', 'pagination');
        navigation.setAttribute('aria-label', 'Bounded evidence windows');
        const previous = button(doc, 'Previous window', 'single-site-previous-window');
        previous.disabled = true;
        const first = singleSiteNumber(0, rawPage.offset) + 1;
        const last = singleSiteNumber(first, rawPage.scan?.nextOffset ?? rawPage.nextOffset);
        const status = element(doc, 'span', 'muted', `Source rows ${Math.min(first, state.accepted.total)}–${Math.min(last, state.accepted.total)}`);
        const next = button(doc, 'Next window', 'single-site-next-window', () => void loadSequence({ append: true, restoreAnchor: false }));
        next.disabled = !state.accepted.nextCursor;
        navigation.append(previous, status, next);
        queueRegion.append(navigation);
      }
    },
    renderViewer(context) {
      const { doc, viewerRegion, state, navigate, selectMemberById, retrySelectedMedia, loadSelected, dispatch, setActiveVideo } = context;
      viewerRegion.replaceChildren();
      const row = state.accepted.items.find(({ id }) => id === state.selection.itemId);
      if (!row) {
        viewerRegion.append(element(doc, 'div', 'gallery-empty single-site-workspace-empty', 'No evidence matches the current review filters.'));
        return;
      }
      const item = selectedRaw(state);
      if (!state.detail) {
        if (state.requests.detail.status === 'error') {
          viewerRegion.append(element(doc, 'h2', null, 'Selected evidence is unavailable'), element(doc, 'p', null, state.requests.detail.error), button(doc, 'Retry selected evidence', 'single-site-retry-item', () => void loadSelected()));
        } else viewerRegion.append(element(doc, 'h2', null, row.title), element(doc, 'div', 'gallery-loader', 'Loading selected evidence and exact baseline identity…'));
        return;
      }
      const heading = element(doc, 'div', 'single-site-viewer-heading');
      const copy = element(doc, 'div');
      copy.append(element(doc, 'p', 'step-label', `${item.auditId} · ${item.caseId}`), element(doc, 'h2', null, item.title));
      const nav = element(doc, 'div', 'single-site-viewer-navigation');
      const selectedOrdinal = rawPage?.queuePosition?.itemId === item.itemId
        ? singleSiteNumber(Math.max(0, state.accepted.items.indexOf(row)) + 1, rawPage.queuePosition.sourceOrdinal)
        : singleSiteNumber(0, rawPage?.offset) + Math.max(0, state.accepted.items.indexOf(row)) + 1;
      nav.append(button(doc, '← Previous', 'single-site-previous-item', () => void navigate(-1)), element(doc, 'span', 'muted', `${selectedOrdinal} of ${state.accepted.total}`), button(doc, 'Next →', 'single-site-next-item', () => void navigate(1)));
      heading.append(copy, nav);
      const strip = element(doc, 'div', 'single-site-visual-status');
      strip.dataset.status = item.visualStatus.toLowerCase();
      strip.append(element(doc, 'strong', null, `Visual review: ${singleSiteHumanize(item.visualStatus)}`), element(doc, 'span', null, item.comparison.reason ?? singleSiteVisualStatusCopy(item.visualStatus)));
      viewerRegion.append(heading, strip);
      const comparison = element(doc, 'section', 'single-site-comparison');
      comparison.setAttribute('aria-label', 'Current, approved baseline, and visual difference');
      const tabs = element(doc, 'div', 'single-site-media-tabs');
      const panes = element(doc, 'div', 'single-site-media-panes');
      const wide = context.viewportMode() === 'desktop';
      const comparisonMembers = [];
      for (const [view, label, role] of [['current', 'Current', 'actual'], ['baseline', 'Approved baseline', 'baseline'], ['diff', 'Difference', 'diff']]) {
        const member = state.detail.item.members.find((candidate) => candidate.role === role);
        const active = member?.id === state.selection.memberId;
        const tab = button(doc, label, `single-site-${view}-tab`, () => void selectMemberById(member.id));
        tab.id = `single-site-${view}-tab`; tab.className = 'single-site-media-tab';
        tabs.append(tab);
        const pane = element(doc, 'div', 'single-site-media-pane');
        pane.id = `single-site-${view}-pane`; pane.dataset.view = view; pane.dataset.active = active ? 'true' : 'false';
        pane.append(element(doc, 'h3', null, label));
        if (!active) pane.append(element(doc, 'div', 'single-site-media-empty', view === 'baseline'
          ? item.visualStatus === 'incompatible' ? 'An approved baseline exists, but its rendering identity is incompatible.' : 'No compatible approved baseline exists for this exact visual identity.'
          : view === 'diff' ? 'No visual difference image was published for this evidence.' : `${label} is available from its comparison tab.`));
        else if (state.media.status === 'loading' || state.media.status === 'idle') pane.append(element(doc, 'div', 'gallery-loader', `Loading ${label.toLowerCase()}…`));
        else if (state.media.status === 'error' || !state.media.source) pane.append(element(doc, 'div', 'single-site-media-empty', state.media.error ?? `${label} media is unavailable.`), button(doc, 'Retry member', 'retry-media', () => void retrySelectedMedia()));
        else if (item.kind === 'video' && view === 'current') {
          const video = element(doc, 'video', 'single-site-media');
          video.controls = true; video.preload = 'metadata'; video.src = state.media.source.url;
          if (state.media.source.posterUrl) video.poster = state.media.source.posterUrl;
          video.addEventListener('loadedmetadata', () => dispatch({ type: 'MEDIA_ELEMENT_LOADED', itemId: state.selection.itemId, memberId: state.selection.memberId }));
          video.addEventListener('error', () => dispatch({ type: 'MEDIA_ELEMENT_FAILED', itemId: state.selection.itemId, memberId: state.selection.memberId, error: 'The selected interaction video could not be loaded.' }));
          pane.append(video); setActiveVideo(video);
        } else {
          const image = element(doc, 'img', 'single-site-media');
          image.src = state.media.source.url; image.alt = `${label} visual evidence for ${item.title}; ${item.route}; ${item.targetId}; ${item.capturePoint}`;
          image.addEventListener('load', () => dispatch({ type: 'MEDIA_ELEMENT_LOADED', itemId: state.selection.itemId, memberId: state.selection.memberId }));
          image.addEventListener('error', () => dispatch({ type: 'MEDIA_ELEMENT_FAILED', itemId: state.selection.itemId, memberId: state.selection.memberId, error: 'The selected image could not be loaded.' }));
          pane.append(image);
        }
        panes.append(pane);
        comparisonMembers.push({ tab, pane, active, view });
      }
      renderedComparison = { tabs, members: comparisonMembers };
      updateComparisonSemantics(wide);
      comparison.append(tabs, panes);
      viewerRegion.append(comparison);
      const reviewActions = element(doc, 'section', 'single-site-review-actions');
      reviewActions.append(element(doc, 'h3', null, 'Human visual disposition'), element(doc, 'p', 'muted', 'A disposition documents visual review only. Findings, coverage, Site Health, and promotion authority remain unchanged.'));
      if (item.visualStatus === 'CHANGED') {
        const action = button(doc, 'Record visual disposition', 'single-site-review-visual', () => options.onVisualReviewIntent?.({ item, opener: action }));
        action.className = 'secondary-button'; action.disabled = !rawHead?.mutationCapability?.authorized; reviewActions.append(action);
        if (action.disabled) reviewActions.append(element(doc, 'p', 'baseline-ineligible', 'Read-only: visual dispositions require an authorized operator session.'));
      } else if (item.visualStatus === 'REVIEWED') reviewActions.append(element(doc, 'p', 'baseline-eligible', `${singleSiteHumanize(item.comparison?.review?.disposition ?? 'reviewed')} · ${item.comparison?.review?.rationale ?? 'No rationale was returned.'}`));
      else reviewActions.append(element(doc, 'p', 'muted', 'Only a current changed pixel comparison can receive a human disposition.'));
      const baseline = element(doc, 'section', 'single-site-baseline-actions');
      baseline.append(element(doc, 'h3', null, 'Approved visual baseline'), element(doc, 'p', 'muted', 'Baseline actions never change deterministic Findings, Site Health, or promotion authority.'));
      const actions = element(doc, 'div', 'dialog-actions');
      const authorized = Boolean(rawHead?.mutationCapability?.authorized ?? rawHead?.baselineMutationCapability?.authorized);
      const baselineButton = (label, operation, enabled) => {
        const action = button(doc, label, `single-site-baseline-${operation}`, () => options.onBaselineIntent?.({ operation, item, opener: action }));
        action.className = operation === 'delete' ? 'secondary-button danger-button' : 'secondary-button'; action.disabled = !enabled; return action;
      };
      if (!item.baseline) actions.append(baselineButton('Approve current as baseline', 'approve', authorized && item.eligible));
      else actions.append(baselineButton('Replace with current', 'replace', authorized && item.eligible), baselineButton('Revoke baseline', 'revoke', authorized), baselineButton('Delete baseline media', 'delete', authorized));
      baseline.append(actions, element(doc, 'p', item.eligible ? 'baseline-eligible' : 'baseline-ineligible', !authorized ? 'Read-only: baseline changes require an authorized operator session.' : item.eligible ? 'This completed, authoritative evidence is eligible for explicit approval.' : `Not eligible for approval: ${item.ineligibilityReasons.join('; ') || 'the server did not publish an eligible evidence record.'}`));
      viewerRegion.append(reviewActions, baseline);
    },
    renderFilmstrip({ filmstripRegion }) { filmstripRegion.hidden = true; filmstripRegion.replaceChildren(); },
    renderContext({ doc, contextRegion, state }) {
      contextRegion.hidden = !state.layers.context; contextRegion.replaceChildren();
      if (contextRegion.hidden) return;
      const heading = element(doc, 'h2', null, 'Test context');
      heading.tabIndex = -1;
      heading.dataset.focusKey = 'context-heading';
      contextRegion.append(heading);
      const item = selectedRaw(state);
      if (!item || !state.detail) { contextRegion.append(element(doc, 'div', 'gallery-loader', 'Loading context…')); return; }
      const list = element(doc, 'dl', 'gallery-context-list');
      for (const [label, value] of [
        ['Audit', item.auditId], ['Case', item.caseId], ['Test ID', item.testContext?.testId ?? 'Unknown'], ['Suite', item.suite],
        ['Severity', item.severity], ['Route', item.route], ['Target', item.targetId], ['Theme', item.theme], ['Capture point', item.capturePoint],
        ['Finding state', item.findingCount ? `${item.findingCount} unresolved` : 'Clear'], ['Coverage', item.coverageGap ? 'Coverage gap' : 'Covered'],
        ['Visual review', item.visualStatus], ['Baseline', item.baseline ? `${item.baseline.baselineId} · approved ${item.baseline.approvedAt ?? 'at an unknown time'}` : 'No compatible approved baseline'],
      ]) singleSiteAppendContextPair(doc, list, label, value);
      contextRegion.append(list, element(doc, 'p', 'muted', 'Keyboard: Left and Right move through evidence; Up and Down move by suite; brackets move through comparison members.'));
    },
    renderOverview({ overviewRegion }) { overviewRegion.hidden = true; overviewRegion.replaceChildren(); },
  };

  const adapter = {
    async loadHead({ signal }) {
      rawHead = await dataSource.loadHead({ signal });
      options.onHead?.(rawHead);
      return singleSiteHeadForCore(rawHead);
    },
    async loadItems({ query, contentRevision, cursor, limit, anchorItemId, signal }) {
      const filters = singleSiteFiltersFromQuery(query);
      const offset = cursor == null ? 0 : Math.max(0, Number(cursor) || 0);
      const rawAnchor = anchorItemId ? rawByCoreId.get(anchorItemId)?.itemId ?? initialRawId : null;
      const page = await dataSource.loadItems({
        filters, offset, limit: Math.min(50, limit), anchorItemId: rawAnchor,
        publicationRevision: contentRevision ?? rawHead?.publicationRevision,
        baselineStoreRevision: singleSiteInteger(rawHead?.baselineStoreRevision ?? rawHead?.storeRevision),
        reviewRevision: singleSiteInteger(rawHead?.reviewRevision), signal,
      });
      if (page.publicationRevision !== rawHead?.publicationRevision
        || singleSiteInteger(page.baselineStoreRevision) !== singleSiteInteger(rawHead?.baselineStoreRevision ?? rawHead?.storeRevision)
        || singleSiteInteger(page.reviewRevision) !== singleSiteInteger(rawHead?.reviewRevision)) {
        const error = new Error('The gallery changed while its bounded queue was loading.');
        error.status = 409; error.code = 'SINGLE_SITE_GALLERY_REVISION_STALE'; throw error;
      }
      rawPage = page;
      const items = (Array.isArray(page.items) ? page.items : []).map(remember).filter(Boolean);
      const ordered = filterSingleSiteGalleryItems(items, filters);
      const included = new Set(ordered.map(({ itemId }) => itemId));
      ordered.push(...items.filter(({ itemId }) => !included.has(itemId)));
      return {
        items: ordered.map(singleSiteCoreRow), total: singleSiteNumber(items.length, page.total), offset: singleSiteNumber(offset, page.offset),
        nextCursor: page.hasMore ? String(page.nextOffset) : null,
        contentRevision: String(page.publicationRevision), orderRevision: singleSiteRevision(page),
        flagRevision: String(singleSiteInteger(page.reviewRevision) ?? ''), phase: 'sealed',
      };
    },
    async loadItem({ itemId, signal }) {
      const row = rawByCoreId.get(itemId);
      if (!row) throw new TypeError('The selected Single-site row is unavailable.');
      const result = await dataSource.loadItem({
        itemId: row.itemId, publicationRevision: rawHead?.publicationRevision,
        baselineStoreRevision: singleSiteInteger(rawHead?.baselineStoreRevision ?? rawHead?.storeRevision),
        reviewRevision: singleSiteInteger(rawHead?.reviewRevision), signal,
      });
      const rawDetail = result?.item ?? result;
      const carriesVisualStatus = rawDetail && typeof rawDetail === 'object' && ('visualReviewStatus' in rawDetail || 'visualStatus' in rawDetail);
      const item = remember({ ...row, ...rawDetail, ...(!carriesVisualStatus && rawDetail?.comparison ? { visualStatus: undefined } : {}) });
      if (!item) throw new TypeError('The selected evidence detail is invalid.');
      details.set(itemId, item);
      while (details.size > GALLERY_LIMITS.retainedDetails) details.delete(details.keys().next().value);
      return singleSiteCoreDetail(item);
    },
    async resolveMedia({ item, member, mediaReference }) {
      const source = details.get(item.id) ?? rawByCoreId.get(item.id);
      const view = member.role === 'actual' ? 'current' : member.role;
      const value = mediaReference?.href ?? source?.media?.[view] ?? null;
      const url = options.resolveMediaUrl?.({ value, item: source, view }) ?? value;
      return url ? { validatedByAdapter: true, url, posterUrl: view === 'current' && source?.kind === 'video'
        ? options.resolveMediaUrl?.({ value: source.media.poster, item: source, view: 'poster' }) ?? null : null } : null;
    },
  };

  const core = createGalleryWorkbench(root, {
    adapter,
    scheduler: options.scheduler,
    announce: options.announce,
    fullscreen: options.fullscreen,
    isInteractionBlocked: options.isInteractionBlocked,
    focusViewerAfterSelection: true,
    replaceDefaultClasses: true,
    classes: {
      shell: 'single-site-gallery', status: 'single-site-gallery-status', controls: 'single-site-gallery-controls',
      body: 'single-site-gallery-body', queue: 'single-site-review-queue', viewerColumn: 'single-site-viewer-column',
      viewer: 'single-site-review-workspace', filmstrip: 'single-site-filmstrip', context: 'single-site-review-context', overview: 'single-site-overview',
    },
    initialState: { query: singleSiteQuery(initialFilters) },
    presentation,
  });
  const shell = root.children[0];
  shell.dataset.galleryController = 'shared-core';
  shell.setAttribute('aria-label', 'Single-site visual evidence review');
  shell.setAttribute('aria-keyshortcuts', Object.values(GALLERY_KEYS).join(' '));

  const emit = (state, action) => {
    const projected = facadeState(state);
    options.onStateChange?.(projected, action);
    for (const listener of facadeSubscribers) listener(projected, action);
    const loading = Object.values(state.requests).some(({ status }) => status === 'loading');
    const error = state.requests.head.error ?? state.requests.query.error ?? null;
    const statusKey = `${loading}|${error ?? ''}`;
    if (statusKey !== lastStatusKey) {
      lastStatusKey = statusKey;
      options.onStatus?.({ status: error ? 'error' : loading ? 'loading' : 'ready', message: error ? 'Gallery unavailable' : loading ? 'Loading gallery…' : 'Gallery connected', error: error ? new Error(error) : null, state: projected });
    }
  };
  const unsubscribe = core.subscribe(emit);

  async function load({ preferredItemId = facadeState().selectedId } = {}) {
    const head = await core.loadHead();
    if (!head) {
      const error = new Error(core.getState().requests.head.error ?? 'The Single-site gallery descriptor is unavailable.');
      options.onFatal?.(error); return false;
    }
    let result;
    if (core.getState().pendingRevision) {
      await core.applyPendingRevision();
      result = core.getState().accepted.contentRevision === head.contentRevision;
    } else result = await core.loadSequence({
      revision: head.contentRevision, orderRevision: head.orderRevision, flagRevision: head.flagRevision,
      preferredItemId: preferredItemId ? coreByRawId.get(preferredItemId) ?? singleSiteCoreItemId(preferredItemId) : null,
    });
    if (!result) {
      const message = core.getState().requests.query.error;
      if (message) options.onFatal?.(new Error(message));
      return false;
    }
    return true;
  }

  return Object.freeze({
    load,
    loadPage: () => core.loadSequence({ restoreAnchor: true }),
    selectItem: (itemId) => core.selectItem(coreByRawId.get(itemId) ?? singleSiteCoreItemId(itemId)),
    navigate: (direction) => core.navigate?.(direction),
    setFilters(filters) {
      const current = facadeState().filters;
      return core.setQuery(singleSiteQuery({ ...current, ...filters }));
    },
    getState: () => facadeState(),
    subscribe(listener) { facadeSubscribers.add(listener); return () => facadeSubscribers.delete(listener); },
    destroy() {
      if (destroyed) return;
      destroyed = true; unsubscribe(); core.destroy();
      const projected = facadeState(core.getState());
      for (const listener of facadeSubscribers) listener(projected, { type: 'DESTROY' });
      facadeSubscribers.clear();
    },
  });
}
