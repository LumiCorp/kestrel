import {
  Component,
  type ErrorInfo,
  type ReactNode,
} from "react";

interface RendererErrorBoundaryProps {
  children: ReactNode;
}

interface RendererErrorBoundaryState {
  failed: boolean;
}

export class RendererErrorBoundary extends Component<
  RendererErrorBoundaryProps,
  RendererErrorBoundaryState
> {
  public state: RendererErrorBoundaryState = { failed: false };

  public static getDerivedStateFromError(): RendererErrorBoundaryState {
    return { failed: true };
  }

  public componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Kestrel Desktop renderer failed.", error, info.componentStack);
  }

  public render(): ReactNode {
    if (this.state.failed) {
      return (
        <main className="renderer-failure" role="alert">
          <strong>Kestrel hit a problem</strong>
          <p>The current view could not be displayed.</p>
          <button
            className="secondary-button"
            type="button"
            onClick={() => window.location.reload()}
          >
            Reload Kestrel
          </button>
        </main>
      );
    }

    return this.props.children;
  }
}
