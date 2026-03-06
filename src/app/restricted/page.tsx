import React from 'react';

export default function RestrictedPage() {
    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100dvh',
            padding: '24px',
            textAlign: 'center',
            background: 'var(--surface-black-primary)',
            color: 'var(--text-white-primary)',
            fontFamily: 'var(--font-manrope), sans-serif',
        }}>
            <div style={{
                padding: '32px',
                borderRadius: '24px',
                background: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                backdropFilter: 'blur(20px)',
                maxWidth: '400px',
                width: '100%',
                boxShadow: '0 20px 40px rgba(0,0,0,0.4)'
            }}>
                <div style={{
                    fontSize: '48px',
                    marginBottom: '24px',
                }}>
                    🚫
                </div>
                <h1 style={{
                    fontSize: '24px',
                    fontWeight: '800',
                    marginBottom: '16px',
                    background: 'linear-gradient(to right, #fff, rgba(255,255,255,0.7))',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                }}>
                    Region Restricted
                </h1>
                <p style={{
                    fontSize: '15px',
                    lineHeight: '1.6',
                    color: 'var(--text-white-secondary)',
                    marginBottom: '24px',
                }}>
                    Our services are currently not available in your region due to local regulations. We apologize for any inconvenience.
                </p>
                <div style={{
                    height: '1px',
                    background: 'rgba(255,255,255,0.1)',
                    width: '100%',
                    marginBottom: '24px',
                }} />
                <p style={{
                    fontSize: '12px',
                    color: 'var(--text-white-tertiary)',
                }}>
                    If you believe this is an error, please contact support.
                </p>
            </div>
        </div>
    );
}
