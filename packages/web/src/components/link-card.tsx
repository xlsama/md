import { useSyncExternalStore } from 'react';
import { linkDomain } from '../lib/link-block.ts';
import { loadLinkMeta, readLinkMeta, subscribeLinkMeta } from '../lib/link-meta.ts';

/**
 * The Notion-style bar a bare-link paragraph renders as.
 *
 * Three states share one geometry so the page does not reflow as metadata
 * arrives: a shimmering skeleton, the full card, and — when the page could not
 * be read at all — a minimal card carrying just the domain and the URL. The
 * thumbnail is only ever a right-hand accent, so a page without an `og:image`
 * loses the image and nothing else.
 */
export function LinkCard({ url }: { url: string }) {
  const state = useSyncExternalStore(
    (onChange) => subscribeLinkMeta(url, onChange),
    () => {
      loadLinkMeta(url);
      return readLinkMeta(url);
    }
  );

  const domain = linkDomain(url);

  if (state.status === 'loading') {
    return (
      <div className="md-link-card md-link-card-skeleton" aria-busy="true" aria-label={url}>
        <div className="md-link-card-body">
          <span className="md-link-card-bone md-link-card-bone-title" />
          <span className="md-link-card-bone md-link-card-bone-text" />
          <span className="md-link-card-bone md-link-card-bone-meta" />
        </div>
        <span className="md-link-card-bone md-link-card-bone-thumb" />
      </div>
    );
  }

  const meta = state.status === 'ready' ? state.meta : null;
  const title = meta?.title ?? domain;
  const description = meta?.description ?? null;
  const image = meta?.image ?? null;
  const favicon = meta?.favicon ?? null;
  const caption = meta?.siteName ?? meta?.domain ?? domain;

  return (
    <a
      className="md-link-card"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={url}
      data-minimal={meta === null ? '' : undefined}
    >
      <span className="md-link-card-body">
        <span className="md-link-card-title">{title}</span>
        <span className="md-link-card-desc">{description ?? url}</span>
        <span className="md-link-card-meta">
          {favicon === null ? (
            <span className="md-link-card-favicon md-link-card-favicon-blank" aria-hidden="true" />
          ) : (
            <img
              className="md-link-card-favicon"
              src={favicon}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={(event) => {
                event.currentTarget.classList.add('md-link-card-favicon-blank');
              }}
            />
          )}
          <span className="md-link-card-domain">{caption}</span>
        </span>
      </span>
      {image === null ? null : (
        <img
          className="md-link-card-thumb"
          src={image}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={(event) => {
            event.currentTarget.remove();
          }}
        />
      )}
    </a>
  );
}
