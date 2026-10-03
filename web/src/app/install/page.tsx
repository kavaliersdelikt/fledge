import Link from "next/link";
import { BrandMark } from "@/lib/brand";
import { ArrowUpRight, BookOpen, ChevronRight, Download, HardDrive } from "lucide-react";

export default function InstallPage() {
  return (
    <main className="doc">
      <Link href="/" className="auth__brand">
        <BrandMark />
      </Link>
      <header>
        <h1>Your panel is already installed</h1>
        <p>
          This page belongs to a running Fledge panel, so there’s nothing to install here. These are the usual next
          steps.
        </p>
      </header>
      <nav className="doc-links" aria-label="Next steps">
        <Link className="doc-link" href="/nodes">
          <HardDrive />
          <div>
            <strong>Connect a node</strong>
            <small>Add a Linux host with Docker and run the one-line agent connector on it.</small>
          </div>
          <ChevronRight />
        </Link>
        <Link className="doc-link" href="/updates">
          <Download />
          <div>
            <strong>Update this panel</strong>
            <small>Install the latest release. Your database and settings are kept.</small>
          </div>
          <ChevronRight />
        </Link>
        <a className="doc-link" href="https://github.com/kavaliersdelikt/fledge#quick-start" target="_blank" rel="noreferrer">
          <BookOpen />
          <div>
            <strong>Install Fledge on another host</strong>
            <small>The quick start in the repository covers install commands and health checks.</small>
          </div>
          <ArrowUpRight />
        </a>
      </nav>
      <p className="faint small">
        Nodes connect outbound to the panel, so they don’t need an open inbound port. On Windows, nodes run inside a
        WSL2 Linux distribution.
      </p>
    </main>
  );
}
