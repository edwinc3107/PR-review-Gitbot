// Test file to verify coverage detection works
import { describe, test, expect } from '@jest/globals';
import { computeImpactScore, typePR, computeRegressionRisk } from './index.js';

describe('PR Review Bot - Coverage Tests', () => {
    // Test computeImpactScore
    test('should calculate impact score for small PR', () => {
        const result = computeImpactScore({
            additions: 50,
            deletions: 20,
            changed_files: 2,
            commit_count: 1,
            review_count: 0
        });
        
        expect(result.score).toBeGreaterThan(0);
        expect(result.category).toBe('Small PR');
    });
    
    test('should calculate impact score for medium PR', () => {
        const result = computeImpactScore({
            additions: 200,
            deletions: 100,
            changed_files: 10,
            commit_count: 5,
            review_count: 2
        });
        
        expect(result.score).toBeGreaterThanOrEqual(200);
        expect(result.category).toBe('Medium PR');
    });
    
    test('should calculate impact score for large PR', () => {
        const result = computeImpactScore({
            additions: 1000,
            deletions: 500,
            changed_files: 20,
            commit_count: 10,
            review_count: 5
        });
        
        expect(result.score).toBeGreaterThanOrEqual(800);
        expect(result.category).toBe('Large / High-risk PR');
    });
    
    // Test PR type detection
    test('should detect Bug Fix PR', () => {
        const result = typePR(['fix: bug in login', 'update readme']);
        expect(result).toBe('Bug Fix PR');
    });
    
    test('should detect Feature PR', () => {
        // Note: "docs" keyword comes before "feat" in the function, so avoid "docs" in test
        const result = typePR(['feat: add new feature', 'implement new functionality']);
        expect(result).toBe('Feature PR');
    });
    
    test('should detect Refactor PR', () => {
        const result = typePR(['refactor: clean up code']);
        expect(result).toBe('Refactor PR');
    });
    
    test('should detect Documentation PR', () => {
        const result = typePR(['docs: update readme']);
        expect(result).toBe('Documentation PR');
    });
    
    test('should return null for unknown PR type', () => {
        const result = typePR(['random commit message']);
        expect(result).toBeNull();
    });
    
    // Test regression risk calculation
    test('should calculate medium regression risk for large PR', () => {
        // With largeDiff (0.4) + manyFiles (0.35):
        // Score = 1 - (1-0.4)*(1-0.35) = 1 - 0.39 = 0.61 (Medium risk)
        const pr = {
            additions: 600,  // Large diff (>500)
            deletions: 100,
            changed_files: 15  // Many files (>10)
        };
        
        const result = computeRegressionRisk(pr);
        
        expect(result.score).toBeGreaterThan(0);
        expect(result.score).toBeGreaterThan(0.4);
        expect(result.category).toBe('Medium risk');
    });
    
    test('should calculate low regression risk for small PR', () => {
        const pr = {
            additions: 50,
            deletions: 10,
            changed_files: 2
        };
        
        const result = computeRegressionRisk(pr);
        
        expect(result.score).toBeLessThanOrEqual(0.4);
        expect(result.category).toBe('Low risk');
    });
    
    test('should handle missing PR data', () => {
        const pr = {
            additions: undefined,
            deletions: undefined,
            changed_files: undefined
        };
        
        const result = computeRegressionRisk(pr);
        
        expect(result.score).toBe(0);
        expect(result.category).toBe('Low risk');
    });
});
