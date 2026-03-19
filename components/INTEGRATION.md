# PartnersSection — integration & design

## 1. Next.js integration (3–4 lines)

- Copy `PartnersSection.jsx` into your app (e.g. `components/PartnersSection.jsx`).
- Ensure Tailwind is configured (the component uses only Tailwind utilities).
- Render: `import PartnersSection from '@/components/PartnersSection';` then `<PartnersSection />` in the page. Optional props: `partners={data}`, `contactUrl="/contact"`.
- To load from API/CMS: in `getStaticProps` or `getServerSideProps` fetch partners and pass `partners`; or use SWR/useEffect and pass the result as `partners` prop.

---

## 2. CSS / Tailwind snippet (hover & focus)

Use in global CSS or a `@layer components` block if you want stronger card emphasis:

```css
/* Card hover — lift + shadow */
.partners-card-custom {
  transition: transform 0.18s ease-out, box-shadow 0.18s ease-out;
}
.partners-card-custom:hover {
  transform: translateY(-4px);
  box-shadow: 0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1);
}
/* Accessible focus */
.partners-card-custom:focus-visible {
  outline: 2px solid #0b6ef6;
  outline-offset: 2px;
}
```

Tailwind-only equivalent on the card `<a>`:  
`transition-all duration-[180ms] ease-out hover:-translate-y-1 hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-blue-600 focus:ring-offset-2`

---

## 3. API / CMS integration (comment block)

```javascript
// Replace hardcoded SAMPLE_PARTNERS:
// Next.js: export async function getStaticProps() {
//   const partners = await fetch('https://your-cms.com/partners').then(r => r.json());
//   return { props: { partners } };
// }
// Client: useEffect(() => { fetch('/api/partners').then(r => r.json()).then(setPartners); }, []);
// SWR: const { data: partners } = useSWR('/api/partners', fetcher); <PartnersSection partners={partners ?? []} />
```

---

## 4. Design notes (for visual match)

1. **Typography:** Inter (or system-ui) with font-weight 600 for headings and 400–500 for body. Headline uses tight tracking; body and descriptions use `text-gray-600` for contrast (WCAG AA).
2. **Spacing:** Hero uses `py-20` and generous horizontal padding; grid gap 24–32px (`gap-6` / `lg:gap-8`); card padding 16px (sm: 20px). Section max-width 72rem with consistent horizontal padding.
3. **Hero:** Single centered H1 + one-sentence subtitle, max-width on subtitle for line length. Visually distinct via size (text-4xl/5xl) and weight 600.
4. **Colour & cards:** Primary CTA `#0b6ef6` (Tailwind blue-600). Cards `bg-white` with `ring-1 ring-gray-100`; muted areas use `bg-gray-50`. Category pills and “Visit site” use blue-600 for affordance.
