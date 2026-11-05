import React from 'react';

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Ошибка рендера в одном компоненте не должна превращать всю панель в белый экран
 */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Ошибка интерфейса:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="min-h-dvh bg-page flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-card border border-line rounded-2xl p-6 space-y-4 text-center">
          <h1 className="text-lg font-semibold text-ink">Что-то пошло не так</h1>
          <p className="text-sm text-muted break-words">{this.state.error.message}</p>
          <button
            onClick={() => window.location.reload()}
            className="bg-brand hover:bg-brand text-on-accent text-sm font-bold px-5 py-2 rounded-lg transition btn-press hover:text-on-accent"
          >
            Перезагрузить страницу
          </button>
        </div>
      </div>
    );
  }
}
