/**
 * PartnersSection.jsx — ReturnPal Partners (production-ready)
 * Premium, trust-building partner grid with hero, featured scroller, filters, and cards.
 * Tailwind only; self-contained.
 *
 * API/CMS: Replace SAMPLE_PARTNERS by passing `partners` prop from:
 *   - Next.js: getStaticProps → fetch your API/CMS, return { props: { partners } }
 *   - Client: useEffect(() => fetch('/api/partners').then(r => r.json()).then(setPartners), [])
 *   - SWR: const { data: partners } = useSWR('/api/partners', fetcher); pass partners or default to SAMPLE_PARTNERS
 */

import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';

// ---------------------------------------------------------------------------
// Sample data (6 partners for layout/UX; replace via props or API)
// ---------------------------------------------------------------------------
const SAMPLE_PARTNERS = [
  {
    id: '1',
    name: 'ProfitSweep',
    logoUrl: '/assets/img/partners/profitsweep.png',
    websiteUrl: 'https://profitsweep.com/',
    description: 'A discord group for FBA sellers that provides real-time A2A bots, expert support, and community-driven tools for Amazon FBA success.',
    categories: ['Technology'],
    featured: true,
  },
  {
    id: '2',
    name: 'LiveCops',
    logoUrl: '/assets/img/partners/livecops.png',
    websiteUrl: 'https://livecops.io/',
    description: 'Reseller community for Amazon sellers that provides real-time product leads, restock alerts, expert guidance, and software tools to help members identify profitable flips and grow their FBA business.',
    categories: ['Technology'],
    featured: true,
  },
  {
    id: '3',
    name: 'SellerMetrics Agency',
    logoUrl: 'https://placehold.co/160x56/f8fafc/0b6ef6?text=SellerMetrics',
    websiteUrl: 'https://example.com/sellermetrics',
    description: 'Full-service Amazon agency. We refer clients to ReturnPal for returns recovery and use your reports in our dashboards.',
    categories: ['Agencies'],
    featured: true,
  },
  {
    id: '4',
    name: 'LedgerRight Accounting',
    logoUrl: 'https://placehold.co/160x56/f8fafc/059669?text=LedgerRight',
    websiteUrl: 'https://example.com/ledgerright',
    description: 'Accountancy firm specialising in e-commerce. Clean P&L exports and ROI reports from ReturnPal fit our workflow.',
    categories: ['Accountants'],
    featured: true,
  },
  {
    id: '5',
    name: 'FulfilLogic',
    logoUrl: 'https://placehold.co/160x56/f8fafc/7c3aed?text=FulfilLogic',
    websiteUrl: 'https://example.com/fulfillogic',
    description: 'Logistics and fulfilment partner. We recommend ReturnPal for returns handling so sellers get one less thing to manage.',
    categories: ['Logistics'],
    featured: false,
  },
  {
    id: '6',
    name: 'ChannelStack',
    logoUrl: 'https://placehold.co/160x56/f8fafc/0b6ef6?text=ChannelStack',
    websiteUrl: 'https://example.com/channelstack',
    description: 'Technology platform for multichannel sellers. ReturnPal integration for recovery data and reimbursement tracking.',
    categories: ['Technology'],
    featured: false,
  },
  {
    id: '7',
    name: 'Books & Tax Co',
    logoUrl: 'https://placehold.co/160x56/f8fafc/dc2626?text=Books+Tax',
    websiteUrl: 'https://example.com/bookstax',
    description: 'Accountants for online sellers. ReturnPal exports and invoices make reconciliation simple for our clients.',
    categories: ['Accountants'],
    featured: false,
  },
];

const CATEGORIES = ['All', 'Agencies', 'Accountants', 'Logistics', 'Technology'];

// Debounce hook for search
function useDebounce(value, delay) {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debouncedValue;
}

// ---------------------------------------------------------------------------
// Featured scroller (subtle auto-scroll, pause on hover)
// ---------------------------------------------------------------------------
function FeaturedScroller({ partners, className = '' }) {
  const scrollRef = useRef(null);
  const rafRef = useRef(null);
  const pausedRef = useRef(false);

  const tick = useCallback(() => {
    if (!scrollRef.current || pausedRef.current) return;
    const el = scrollRef.current;
    const max = el.scrollWidth - el.clientWidth;
    if (max <= 0) return;
    el.scrollLeft += 0.5;
    if (el.scrollLeft >= max) el.scrollLeft = 0;
  }, []);

  useEffect(() => {
    const loop = () => {
      tick();
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => rafRef.current && cancelAnimationFrame(rafRef.current);
  }, [tick]);

  if (!partners.length) return null;

  return (
    <div className={className}>
      <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4">
        Featured partners
      </h2>
      <div
        ref={scrollRef}
        className="flex gap-6 overflow-x-auto pb-2 scroll-smooth scrollbar-thin"
        style={{ scrollbarWidth: 'thin' }}
        onMouseEnter={() => (pausedRef.current = true)}
        onMouseLeave={() => (pausedRef.current = false)}
        aria-label="Featured partner logos"
      >
        {partners.map((p) => (
          <a
            key={p.id}
            href={p.websiteUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-shrink-0 flex flex-col items-center justify-center w-36 min-h-[7rem] rounded-xl bg-gray-50 ring-1 ring-gray-100 px-4 py-3 transition-shadow duration-[180ms] ease-out hover:ring-gray-200 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-600 focus:ring-offset-2"
            aria-label={`Visit ${p.name} website`}
          >
            <span className="text-sm font-semibold text-gray-900 mb-2">{p.name}</span>
            <img
              src={p.logoUrl}
              alt={`Logo — ${p.name}`}
              width={160}
              height={56}
              loading="lazy"
              className="max-h-14 w-auto max-w-full object-contain"
            />
          </a>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function PartnersSection({ partners = SAMPLE_PARTNERS, contactUrl = '/contact' }) {
  const [category, setCategory] = useState('All');
  const [searchInput, setSearchInput] = useState('');
  const debouncedSearch = useDebounce(searchInput, 280);

  const filteredPartners = useMemo(() => {
    let list = partners;
    if (category !== 'All') {
      list = list.filter((p) => p.categories && p.categories.includes(category));
    }
    if (debouncedSearch.trim()) {
      const q = debouncedSearch.trim().toLowerCase();
      list = list.filter(
        (p) =>
          (p.name && p.name.toLowerCase().includes(q)) ||
          (p.description && p.description.toLowerCase().includes(q))
      );
    }
    return list;
  }, [partners, category, debouncedSearch]);

  const featuredPartners = useMemo(
    () => partners.filter((p) => p.featured).slice(0, 6),
    [partners]
  );

  return (
    <section
      className="bg-white font-sans antialiased"
      style={{ fontFamily: 'Inter, system-ui, sans-serif' }}
      aria-labelledby="partners-heading"
    >
      {/* Hero — roomy, distinct headline */}
      <header className="text-center py-20 px-4 sm:px-6">
        <h1
          id="partners-heading"
          className="text-4xl font-semibold text-gray-900 tracking-tight sm:text-5xl"
        >
          Partner with ReturnPal
        </h1>
        <p className="mt-4 text-lg text-gray-600 max-w-xl mx-auto font-normal">
          We work with agencies, prep centres, FBA groups, and other Amazon service providers to help your clients recover more value from returns while giving you a share of the recovery.
        </p>
      </header>

      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pb-20">
        {/* Featured row — muted bg, up to 6 logos */}
        {featuredPartners.length > 0 && (
          <div className="rounded-2xl bg-gray-50/80 ring-1 ring-gray-100 px-6 py-8 mb-12">
            <FeaturedScroller partners={featuredPartners} />
          </div>
        )}

        {/* Filters + search */}
        {partners.length > 1 && (
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
            <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by category">
              {CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setCategory(cat)}
                  aria-pressed={category === cat}
                  aria-label={`Filter by ${cat}`}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors duration-[180ms] ease-out focus:outline-none focus:ring-2 focus:ring-blue-600 focus:ring-offset-2 ${
                    category === cat
                      ? 'bg-blue-600 text-white'
                      : 'bg-white text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
            <label htmlFor="partners-search" className="sr-only">
              Search partners by name or description
            </label>
            <input
              id="partners-search"
              type="search"
              placeholder="Search partners..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              aria-label="Search partners by name or description"
              className="w-full sm:w-64 px-4 py-2.5 rounded-lg ring-1 ring-gray-200 bg-white text-gray-900 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:ring-offset-0 transition-shadow duration-[180ms]"
            />
          </div>
        )}

        {/* Partner grid — 3 / 2 / 1 */}
        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 lg:gap-8 list-none p-0 m-0">
          {filteredPartners.map((partner) => (
            <li key={partner.id}>
              <a
                href={partner.websiteUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`${partner.name} — visit site`}
                className="group flex flex-col h-full rounded-xl bg-white ring-1 ring-gray-100 p-4 sm:p-5 transition-all duration-[180ms] ease-out hover:-translate-y-1 hover:shadow-lg hover:ring-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:ring-offset-2 focus:ring-offset-white"
              >
                {/* Logo container — fixed height, centered */}
                <div className="flex items-center justify-center h-24 mb-4 rounded-lg bg-gray-50 ring-1 ring-gray-100">
                  <img
                    src={partner.logoUrl}
                    alt={`Logo — ${partner.name}`}
                    width={160}
                    height={56}
                    loading="lazy"
                    className="max-h-14 w-auto max-w-full object-contain"
                  />
                </div>
                <span className="block text-base font-semibold text-gray-900 mb-1">
                  {partner.name}
                </span>
                {partner.categories && partner.categories.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {partner.categories.map((c) => (
                      <span
                        key={c}
                        className="inline-block px-2 py-0.5 text-xs font-medium text-gray-500 bg-gray-100 rounded-md"
                      >
                        {c}
                      </span>
                    ))}
                  </div>
                )}
                <p className="text-sm text-gray-600 leading-relaxed line-clamp-3 flex-1">
                  {partner.description}
                </p>
                {/* Visit site — always visible on mobile, fades in on hover desktop */}
                <span className="mt-4 inline-flex items-center text-sm font-medium text-blue-600 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity duration-[180ms]">
                  Visit site →
                </span>
              </a>
            </li>
          ))}
        </ul>

        {filteredPartners.length === 0 && (
          <p className="text-center text-gray-500 py-12">
            No partners match your filters. Try another category or search.
          </p>
        )}

        {/* CTA — unchanged */}
        <div className="mt-16 text-center">
          <p className="text-gray-600 mb-4">Ready to become a ReturnPal partner?</p>
          <a
            href={contactUrl}
            className="inline-flex items-center justify-center w-full sm:w-auto min-w-[10rem] px-6 py-3 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:ring-offset-2 transition-colors duration-[180ms]"
          >
            Contact us
          </a>
        </div>
      </div>
    </section>
  );
}
