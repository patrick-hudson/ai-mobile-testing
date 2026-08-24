export type CandidateRouteKind =
  | 'home'
  | 'category'
  | 'article'
  | 'calculator'
  | 'crisis'
  | 'meeting'
  | 'search'
  | 'utility';

export interface CandidateRoute {
  path: string;
  kind: CandidateRouteKind;
}

export interface DeclaredVisualItem {
  name: string;
  selector: string;
  kind: 'img' | 'picture' | 'svg' | 'css-diagram';
  exactCount: number;
}

export interface RouteVisualContract {
  path: string;
  items: readonly DeclaredVisualItem[];
}

export interface CriticalContentContract {
  path: string;
  requiredHeadings: readonly string[];
  requiredWarningFragments: readonly string[];
  requiredCandidateDestinations: readonly string[];
  /** Exact production headings reviewed as intentionally absent on candidate. */
  approvedMissingProductionHeadings: readonly string[];
}

/**
 * Static release inventory. Keeping this list explicit makes additions and removals
 * reviewable in pull requests instead of silently accepting whatever a crawl finds.
 * README.md is intentionally not published and therefore is not included.
 */
const CONTENT_PATHS = {
  about: [
    'acknowledgments',
    'changelog',
    'contributing',
    'site-architecture',
    'the-community',
    'this-site',
    'where-we-stand',
  ],
  compounds: [
    '7-oh-ban',
    '7-oh',
    'cats-claw',
    'kratom-leaf',
    'mgm15',
    'mgm16',
    'mit-a-dhm',
    'mitragynine-pseudoindoxyl',
  ],
  'for-loved-ones': [
    'asking-them-to-leave',
    'at-home-recovery',
    'boundaries',
    'fmla-workplace',
    'how-to-talk',
    'rehabilitation-centers',
    'safety',
    'support-groups',
    'taking-care-of-yourself',
    'welcome',
    'what-to-expect',
  ],
  'for-you': [
    'at-home-treatment',
    'fmla-ada-job',
    'mat-and-your-job',
    'mutual-aid',
    'rehabilitation-centers',
    'sober-living',
    'tapering-7oh',
    'welcome',
  ],
  'mat-suboxone': [
    'long-term-suboxone-risks',
    'sows-cows-induction-guide',
    'sublocade-brixadi',
    'suboxone-bernese-method',
    'suboxone-custom-dose',
    'suboxone-for-7oh',
    'suboxone-rapid-taper',
    'why-suboxone-isnt-working',
  ],
  'medications-supplements': [
    'cannabis-thc-in-recovery',
    'helper-meds',
    'mega-dose-vitamin-c',
    'nad-iv-therapy',
    'peptides-for-withdrawal',
    'quit-7-oh-with-kratom-leaf',
    'quit-7-oh-with-mitragynine',
    'quit-kit',
    'sr-17',
    'vitamins-supplements',
  ],
  pharmacology: [
    'chemical-structures',
    'kratom-minor-alkaloids',
    'morphine-vs-kratom',
  ],
  'post-acute': [
    '7-oh-recovery-timeline',
    'depression-and-anhedonia',
    'dopamine-recovery',
    'endocrine-recovery',
    'impending-doom-anxiety',
    'kindling-and-relapse',
    'naltrexone-low-dose',
    'naltrexone-normal-dose',
    'naltrexone-ultra-low-dose',
    'naltrexone',
    'paws-post-acute-withdrawal',
    'pink-cloud',
    'sleep-recovery',
  ],
  resources: [
    '7-oh-taper-calculator',
    'crisis-hotlines',
    'kratom-leaf-taper-calculator',
    'meeting-schedules',
    'recovery-coaching',
    'sr-17-taper-calculator',
    'suboxone-taper-calculator',
    'taper-calculator',
    'telehealth-for-suboxone',
  ],
  'start-here': [
    '7-oh-withdrawal-guide',
    '7-oh-withdrawal-help',
    '7-oh-withdrawal-quickstart',
    'cravings-and-relapse-thoughts',
    'how-to-quit-7-oh',
    'how-to-use-this-website',
    'welcome',
    'what-is-7-oh',
  ],
} as const satisfies Record<string, readonly string[]>;

const CALCULATOR_PATHS = new Set([
  '/resources/7-oh-taper-calculator',
  '/resources/kratom-leaf-taper-calculator',
  '/resources/sr-17-taper-calculator',
  '/resources/suboxone-taper-calculator',
  '/resources/taper-calculator',
]);

const CATEGORY_ROUTES: CandidateRoute[] = Object.keys(CONTENT_PATHS).map((category) => ({
  path: `/${category}`,
  kind: 'category',
}));

const CONTENT_ROUTES: CandidateRoute[] = Object.entries(CONTENT_PATHS).flatMap(
  ([category, slugs]) =>
    slugs.map((slug): CandidateRoute => {
      const path = `/${category}/${slug}`;
      if (path === '/start-here/7-oh-withdrawal-help') return { path, kind: 'crisis' };
      if (CALCULATOR_PATHS.has(path)) return { path, kind: 'calculator' };
      if (path === '/resources/meeting-schedules') return { path, kind: 'meeting' };
      return { path, kind: 'article' };
    }),
);

const CUSTOM_HTML_ROUTES: CandidateRoute[] = [
  { path: '/', kind: 'home' },
  { path: '/brand', kind: 'utility' },
  { path: '/next-kratom-support-meeting', kind: 'meeting' },
  { path: '/search', kind: 'search' },
  { path: '/sitemap', kind: 'utility' },
  { path: '/virtual-na-meetings-now', kind: 'meeting' },
  { path: '/virtual-smart-meetings-now', kind: 'meeting' },
];

export const CANDIDATE_HTML_ROUTES: readonly CandidateRoute[] = [
  ...CUSTOM_HTML_ROUTES,
  ...CATEGORY_ROUTES,
  ...CONTENT_ROUTES,
];

export const CANDIDATE_PATHS: readonly string[] = CANDIDATE_HTML_ROUTES.map(({ path }) => path);

export const DATA_ENDPOINTS = [
  { path: '/search-index.json', name: 'search index' },
  { path: '/live-meeting-index.json', name: 'live meeting index' },
] as const;

export const REPRESENTATIVE_VISUAL_ROUTES = [
  { path: '/', label: 'homepage' },
  { path: '/start-here/welcome', label: 'article' },
  { path: '/start-here', label: 'category' },
  { path: '/resources/7-oh-taper-calculator', label: 'calculator' },
  { path: '/virtual-na-meetings-now', label: 'meeting-directory' },
  { path: '/start-here/7-oh-withdrawal-help', label: 'crisis-fast-path' },
  { path: '/search', label: 'search' },
  { path: '/sitemap', label: 'sitemap' },
] as const;

/**
 * Visuals whose presence is part of the published content contract. Exact
 * counts prevent an empty page (or a silently dropped diagram) from passing.
 */
export const DECLARED_ROUTE_VISUALS: readonly RouteVisualContract[] = [
  {
    path: '/brand',
    items: [
      { name: 'light and dark Lift Cup specimens', selector: '#logo svg.logo-mark', kind: 'svg', exactCount: 2 },
    ],
  },
  {
    path: '/pharmacology/chemical-structures',
    items: [
      { name: 'reviewed molecular structure figures', selector: 'main figure img[src^="/images/structures/"]', kind: 'img', exactCount: 12 },
    ],
  },
  {
    path: '/about/site-architecture',
    items: [
      { name: 'core-stack architecture table', selector: 'main .architecture-table', kind: 'css-diagram', exactCount: 1 },
      { name: 'static publishing pipeline', selector: 'main article > .not-prose > ol', kind: 'css-diagram', exactCount: 1 },
    ],
  },
] as const;

/**
 * Release-critical content is reviewed explicitly. The approved-difference
 * arrays intentionally start empty: a removed production heading blocks the
 * release until a reviewer records the exact heading here.
 */
export const CRITICAL_CONTENT_CONTRACTS: readonly CriticalContentContract[] = [
  {
    path: '/',
    requiredHeadings: ['Help quitting 7-OH', 'Support right now'],
    requiredWarningFragments: ['community-compiled information, not medical advice'],
    requiredCandidateDestinations: ['/start-here/7-oh-withdrawal-quickstart', '/start-here/how-to-quit-7-oh'],
    approvedMissingProductionHeadings: [],
  },
  {
    path: '/start-here/welcome',
    requiredHeadings: ['Welcome', 'Scope and disclaimers', 'Where to go next', 'Find the community'],
    requiredWarningFragments: ['Not medical advice'],
    requiredCandidateDestinations: ['/start-here/7-oh-withdrawal-help', '/about/the-community'],
    approvedMissingProductionHeadings: [],
  },
  {
    path: '/compounds/7-oh',
    requiredHeadings: ['7-OH (7-Hydroxymitragynine)', 'Withdrawal profile', "If you're trying to stop"],
    requiredWarningFragments: ['No direct human PK study of standalone 7-OH has been published'],
    requiredCandidateDestinations: ['/start-here/how-to-quit-7-oh', '/start-here/7-oh-withdrawal-help'],
    approvedMissingProductionHeadings: [],
  },
  {
    path: '/resources/7-oh-taper-calculator',
    requiredHeadings: ['7-OH Taper Calculator', 'Which compound to pick', 'How the math works'],
    requiredWarningFragments: ['Reference, not advice'],
    requiredCandidateDestinations: ['/resources/taper-calculator', '/medications-supplements/helper-meds'],
    approvedMissingProductionHeadings: [],
  },
  {
    path: '/virtual-na-meetings-now',
    requiredHeadings: ['Find a virtual NA meeting happening now'],
    requiredWarningFragments: ['not affiliated with Narcotics Anonymous'],
    requiredCandidateDestinations: ['/next-kratom-support-meeting', '/for-you/mutual-aid'],
    approvedMissingProductionHeadings: [],
  },
] as const;

export const REPRESENTATIVE_A11Y_ROUTES = [
  '/',
  '/start-here/welcome',
  '/start-here/7-oh-withdrawal-help',
  '/resources/7-oh-taper-calculator',
  '/mat-suboxone/sows-cows-induction-guide',
  '/virtual-na-meetings-now',
  '/search',
] as const;

export const REPRESENTATIVE_PERFORMANCE_ROUTES = [
  '/',
  '/start-here/welcome',
  '/resources/7-oh-taper-calculator',
  '/virtual-na-meetings-now',
  '/about/changelog',
] as const;

export const EXPECTED_PUBLISHED_DOCUMENT_COUNT = 85;
export const EXPECTED_CATEGORY_COUNT = 10;
export const EXPECTED_HTML_ROUTE_COUNT = 102;
