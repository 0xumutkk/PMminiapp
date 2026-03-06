'use client';

import React, { useState, useEffect } from 'react';

export function LegalDisclaimer() {
    const [isVisible, setIsVisible] = useState(false);

    useEffect(() => {
        const hasAccepted = localStorage.getItem('legal-disclaimer-accepted');
        if (!hasAccepted) {
            setIsVisible(true);
        }
    }, []);

    const handleAccept = () => {
        localStorage.setItem('legal-disclaimer-accepted', 'true');
        setIsVisible(false);
    };

    if (!isVisible) return null;

    return (
        <div style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '24px',
            backgroundColor: 'rgba(0, 0, 0, 0.85)',
            backdropFilter: 'blur(8px)',
            animation: 'fadeIn 0.3s ease-out',
        }}>
            <style>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes slideUp {
          from { transform: translateY(20px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
      `}</style>
            <div style={{
                backgroundColor: 'var(--surface-black-primary, #0c1014)',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                borderRadius: '24px',
                padding: '32px',
                maxWidth: '440px',
                width: '100%',
                boxShadow: '0 24px 64px rgba(0, 0, 0, 0.6)',
                animation: 'slideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
                display: 'flex',
                flexDirection: 'column',
                gap: '20px',
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <span style={{ fontSize: '24px' }}>⚖️</span>
                    <h2 style={{
                        margin: 0,
                        fontSize: '20px',
                        fontWeight: '800',
                        color: '#fff',
                        letterSpacing: '-0.01em'
                    }}>
                        Legal Disclaimer
                    </h2>
                </div>

                <div style={{
                    fontSize: '14px',
                    lineHeight: '1.6',
                    color: 'rgba(255, 255, 255, 0.7)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '12px',
                }}>
                    <p style={{ margin: 0 }}>
                        By using this application, you acknowledge and agree that this platform is provided for <strong>educational and experimental purposes only</strong>.
                    </p>
                    <p style={{ margin: 0 }}>
                        The developers and operators of this application assume <strong>no responsibility or liability</strong> for any financial losses, damages, or legal issues arising from your activities on the platform.
                    </p>
                    <p style={{ margin: 0 }}>
                        Users are solely responsible for ensuring that their use of this application complies with all applicable local, national, and international laws and regulations.
                    </p>
                </div>

                <button
                    onClick={handleAccept}
                    style={{
                        marginTop: '8px',
                        backgroundColor: '#fff',
                        color: '#000',
                        border: 'none',
                        borderRadius: '999px',
                        padding: '14px 24px',
                        fontSize: '15px',
                        fontWeight: '760',
                        cursor: 'pointer',
                        transition: 'transform 0.2s active',
                        width: '100%',
                    }}
                    onMouseDown={(e) => e.currentTarget.style.transform = 'scale(0.98)'}
                    onMouseUp={(e) => e.currentTarget.style.transform = 'scale(1)'}
                >
                    I Understand & Agree
                </button>
            </div>
        </div>
    );
}
