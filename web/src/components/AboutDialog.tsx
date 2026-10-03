"use client";

import { FledgeMark, useBrand } from "@/lib/brand";
import { Modal } from "./feedback";

const DOCS = "https://kavaliersdelikt.github.io/fledge/";
const REPO = "https://github.com/kavaliersdelikt/fledge";

/**
 * Says what software this is, whatever the panel is called. It cannot be switched off: Fledge is AGPL-3.0 software, and the
 * people using a panel should always be able to find the licence and where its source code is.
 */
export default function AboutDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { brand } = useBrand();
  const renamed = brand.identity.name !== brand.product.name;
  const source = brand.identity.sourceUrl || REPO;
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={`About ${brand.product.name}`}>
      <div className="about">
        <span className="about__mark">
          <FledgeMark />
        </span>
        <div className="about__text">
          <p>
            {renamed ? (
              <>
                <strong>{brand.identity.name}</strong> runs on <strong>{brand.product.name}</strong>, a self-hosted control panel for game servers.
              </>
            ) : (
              <>
                <strong>{brand.product.name}</strong> is a self-hosted control panel for game servers.
              </>
            )}
          </p>
          <dl className="about__facts">
            {brand.product.version ? (
              <>
                <dt>Version</dt>
                <dd>{brand.product.version}</dd>
              </>
            ) : null}
            <dt>Licence</dt>
            <dd>GNU Affero General Public License v3.0 only</dd>
            <dt>Source code</dt>
            <dd>
              <a href={source} target="_blank" rel="noopener noreferrer">
                {source.replace(/^https?:\/\//, "")}
              </a>
            </dd>
            <dt>Documentation</dt>
            <dd>
              <a href={DOCS} target="_blank" rel="noopener noreferrer">
                {DOCS.replace(/^https?:\/\//, "")}
              </a>
            </dd>
          </dl>
        </div>
      </div>
    </Modal>
  );
}
