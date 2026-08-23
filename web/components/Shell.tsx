'use client';

/**
 * VERITY — portal chrome and the identity switcher.
 *
 * The switcher is the most important control in the whole interface, and not
 * for convenience. It is how a judge sees that role and seniority come from a
 * CERTIFICATE rather than a form field: change the acting officer and the same
 * button starts producing a different answer, because the chaincode is reading
 * a different X.509.
 *
 * The synthetic-data banner is permanent and cannot be dismissed. Whitepaper
 * §7.4 lists eleven things Verity does not claim; the least this interface can
 * do is never let a screenshot be mistaken for real supervisory data.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import { api, type Identity } from '@/lib/api';

interface IdentityState {
  identities: Identity[];
  current: Identity | undefined;
  setCurrent: (id: string) => void;
  loading: boolean;
  error: string | undefined;
}

const IdentityContext = createContext<IdentityState>({
  identities: [],
  current: undefined,
  setCurrent: () => {},
  loading: true,
  error: undefined,
});

export const useIdentity = (): IdentityState => useContext(IdentityContext);

const PORTALS = [
  { href: '/bank', label: 'Bank officer' },
  { href: '/supervisor', label: 'Supervisor' },
  { href: '/depositor', label: 'Depositor' },
] as const;

export function Shell({ children }: { children: ReactNode }): ReactNode {
  const pathname = usePathname();
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [currentId, setCurrentId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const portal = PORTALS.find((p) => pathname.startsWith(p.href));

  useEffect(() => {
    let cancelled = false;
    api
      .identities()
      .then((users) => {
        if (cancelled) return;
        setIdentities(users);
        setLoading(false);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setError(
          `Cannot reach the API. Is it running?  ${e.message}`,
        );
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Default to an identity that belongs to the portal being viewed, so the
  // driver never has to remember who can do what.
  useEffect(() => {
    if (identities.length === 0) return;
    const fits = identities.find((u) => portal && u.portal === portal.href.slice(1));
    setCurrentId((prev) => {
      if (prev && identities.some((u) => u.id === prev && (!portal || u.portal === portal.href.slice(1)))) {
        return prev;
      }
      return fits?.id ?? identities[0]?.id;
    });
  }, [identities, portal]);

  const current = identities.find((u) => u.id === currentId);
  const relevant = portal ? identities.filter((u) => u.portal === portal.href.slice(1)) : identities;

  return (
    <IdentityContext.Provider
      value={{ identities, current, setCurrent: setCurrentId, loading, error }}
    >
      <div className="shell">
        <header className="topbar">
          <Link href="/" className="brand" style={{ textDecoration: 'none' }}>
            Verity
            <span className="tag">{portal ? portal.label : 'prototype'}</span>
          </Link>
          <nav>
            {PORTALS.map((p) => (
              <Link key={p.href} href={p.href} data-active={pathname.startsWith(p.href)}>
                {p.label}
              </Link>
            ))}
          </nav>
        </header>

        <div className="synthetic-banner">
          All data synthetic — no real borrower, depositor or institution appears. Institution names are
          placeholders; no organisation has committed to participate.
        </div>

        {portal && (
          <div className="identity-bar">
            <div className="identity">
              <label htmlFor="identity" style={{ margin: 0 }}>
                Acting as
              </label>
              <select
                id="identity"
                value={currentId ?? ''}
                onChange={(e) => setCurrentId(e.target.value)}
                disabled={loading || relevant.length === 0}
              >
                {relevant.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.displayName} — {u.role.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
              {current && (
                <span className="cert">
                  X.509 · <b>{current.mspId}</b> · role=<b>{current.role}</b> · seniority=
                  <b>{current.seniority}</b>
                </span>
              )}
              <span className="hint" style={{ margin: 0 }}>
                read by chaincode from the certificate, not sent by this page
              </span>
            </div>
            {error && <p className="err" style={{ marginBottom: 0 }}>{error}</p>}
          </div>
        )}

        <main>{children}</main>
      </div>
    </IdentityContext.Provider>
  );
}
