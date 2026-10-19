import { Component, Suspense, type ReactNode } from 'react';

export class DeferredPanel extends Component<{ children: ReactNode; label: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <section className="panel deferred-panel" role="alert"><p>{this.props.label} could not load. Other desk controls remain available.</p><button onClick={() => window.location.reload()}>Reload office</button></section>;
    return <Suspense fallback={<section className="panel deferred-panel" role="status" aria-label={'Loading ' + this.props.label}><div className="panel-skeleton" />Loading {this.props.label}…</section>}>{this.props.children}</Suspense>;
  }
}
