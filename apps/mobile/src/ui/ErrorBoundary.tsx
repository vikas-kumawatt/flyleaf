// Global React Error Boundary (SL-82, PRD §28.2).
//
// Intercepts component render exceptions, reports them to Sentry, and presents
// a dignified recovery interface respecting the Flyleaf design system.

import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { StyleSheet, View, Platform } from 'react-native';
import { captureMobileException } from '../lib/sentry';
import { Txt, Button } from './components';
import { space, radius } from './tokens';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    void captureMobileException(error, {
      componentStack: info.componentStack || undefined,
    });
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <View style={styles.container}>
          <View style={styles.card}>
            <Txt variant="title" style={styles.icon}>
              ✦
            </Txt>
            <Txt variant="title" style={styles.title}>
              Something went wrong
            </Txt>
            <Txt variant="body" color="muted" style={styles.subtitle}>
              An unexpected interface error occurred. Your reading logs and offline mirror remain safe.
            </Txt>

            {__DEV__ && this.state.error?.message && (
              <View style={styles.devBox}>
                <Txt variant="caption" style={styles.devText} numberOfLines={4}>
                  {this.state.error.message}
                </Txt>
              </View>
            )}

            <View style={styles.actions}>
              <Button
                label="Try again"
                variant="primary"
                onPress={this.handleReset}
              />
            </View>
          </View>
        </View>
      );
    }

    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0c0a09',
    alignItems: 'center',
    justifyContent: 'center',
    padding: space[4],
  },
  card: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: '#1c1917',
    borderRadius: radius.lg,
    padding: space[6],
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#292524',
  },
  icon: {
    fontSize: 32,
    color: '#f59e0b',
    marginBottom: space[2],
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#fafaf9',
    textAlign: 'center',
    marginBottom: space[2],
  },
  subtitle: {
    fontSize: 14,
    color: '#a8a29e',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: space[4],
  },
  devBox: {
    width: '100%',
    backgroundColor: '#0c0a09',
    borderRadius: radius.sm,
    padding: space[3],
    marginBottom: space[4],
    borderWidth: 1,
    borderColor: '#ef4444',
  },
  devText: {
    color: '#fca5a5',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 12,
  },
  actions: {
    width: '100%',
    marginTop: space[2],
  },
});
