/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AnalyzeImageTool, AnalyzeImageToolParams } from './analyze-image.js';
import path from 'path';
import os from 'os';
import fs from 'fs';
import fsp from 'fs/promises';
import { Config } from '../config/config.js';
import { createMockWorkspaceContext } from '../test-utils/mockWorkspaceContext.js';
import { ToolInvocation, ToolResult } from './tools.js';
import { processSingleFileContent } from '../utils/fileUtils.js';

// Mock the fileUtils to control what processSingleFileContent returns
vi.mock('../utils/fileUtils.js', () => ({
  processSingleFileContent: vi.fn(),
}));

// Mock the Gemini client
const mockGenerateContent = vi.fn();
const mockGeminiClient = {
  generateContent: mockGenerateContent,
};

// Mock the FileService
const mockFileService = {
  shouldGeminiIgnoreFile: vi.fn().mockReturnValue(false),
};

describe('AnalyzeImageTool', () => {
  let tempRootDir: string;
  let tool: AnalyzeImageTool;

  beforeEach(async () => {
    // Create a unique temporary root directory for each test run
    tempRootDir = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'analyze-image-tool-root-'),
    );

    const mockConfigInstance = {
      getFileService: () => mockFileService,
      getTargetDir: () => tempRootDir,
      getWorkspaceContext: () => createMockWorkspaceContext(tempRootDir),
      getGeminiClient: () => mockGeminiClient,
    } as unknown as Config;
    tool = new AnalyzeImageTool(mockConfigInstance);

    // Reset mocks
    vi.resetAllMocks();
    mockFileService.shouldGeminiIgnoreFile.mockReturnValue(false);
  });

  afterEach(async () => {
    // Clean up the temporary root directory
    if (fs.existsSync(tempRootDir)) {
      await fsp.rm(tempRootDir, { recursive: true, force: true });
    }
  });

  describe('build', () => {
    it('should return an invocation for valid params (absolute path within root)', () => {
      const params: AnalyzeImageToolParams = {
        absolute_path: path.join(tempRootDir, 'test.png'),
      };
      const result = tool.build(params);
      expect(typeof result).not.toBe('string');
    });

    it('should throw error if file path is relative', () => {
      const params: AnalyzeImageToolParams = {
        absolute_path: 'relative/path.png',
      };
      expect(() => tool.build(params)).toThrow(
        'File path must be absolute, but was relative: relative/path.png. You must provide an absolute path.',
      );
    });

    it('should throw error if path is outside root', () => {
      const params: AnalyzeImageToolParams = {
        absolute_path: '/outside/root.png',
      };
      expect(() => tool.build(params)).toThrow(
        'File path must be within one of the workspace directories:',
      );
    });
  });

  describe('getDescription', () => {
    it('should return relative path for image file', () => {
      const subDir = path.join(tempRootDir, 'sub', 'dir');
      const params: AnalyzeImageToolParams = {
        absolute_path: path.join(subDir, 'image.png'),
      };
      const invocation = tool.build(params);
      expect(typeof invocation).not.toBe('string');
      expect(
        (
          invocation as ToolInvocation<AnalyzeImageToolParams, ToolResult>
        ).getDescription(),
      ).toBe('Analyze image: sub/dir/image.png');
    });

    it('should handle deep file paths', () => {
      const deepPath = path.join(
        tempRootDir,
        'very',
        'deep',
        'directory',
        'structure',
        'that',
        'exceeds',
        'the',
        'normal',
        'limit',
        'image.png',
      );
      const params: AnalyzeImageToolParams = { absolute_path: deepPath };
      const invocation = tool.build(params);
      expect(typeof invocation).not.toBe('string');
      const desc = (
        invocation as ToolInvocation<AnalyzeImageToolParams, ToolResult>
      ).getDescription();
      expect(desc).toContain('Analyze image:');
      expect(desc).toContain('image.png');
    });
  });

  describe('execute', () => {
    it('should return error if processSingleFileContent fails', async () => {
      const imagePath = path.join(tempRootDir, 'nonexistent.png');

      // Mock processSingleFileContent to return an error
      vi.mocked(processSingleFileContent).mockResolvedValue({
        llmContent: '',
        returnDisplay: 'File not found.',
        error: 'File not found',
      });

      const params: AnalyzeImageToolParams = {
        absolute_path: imagePath,
        analysis_type: 'general',
      };
      const invocation = tool.build(params) as ToolInvocation<
        AnalyzeImageToolParams,
        ToolResult
      >;

      const result = await invocation.execute(new AbortController().signal);
      expect(result).toEqual({
        llmContent: 'Error: File not found',
        returnDisplay: 'Failed to analyze image: File not found.',
      });
    });

    it('should successfully analyze an image with general analysis', async () => {
      const imagePath = path.join(tempRootDir, 'test.png');

      // Mock processSingleFileContent to return a successful result
      const mockImageData = {
        inlineData: {
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
          mimeType: 'image/png',
        },
      };

      vi.mocked(processSingleFileContent).mockResolvedValue({
        llmContent: mockImageData,
        returnDisplay: 'Read image file: test.png',
      });

      // Mock the Gemini client response
      mockGenerateContent.mockResolvedValue({
        text: 'This is a small red square image.',
      });

      const params: AnalyzeImageToolParams = {
        absolute_path: imagePath,
        analysis_type: 'general',
      };
      const invocation = tool.build(params) as ToolInvocation<
        AnalyzeImageToolParams,
        ToolResult
      >;

      const result = await invocation.execute(new AbortController().signal);
      expect(result).toEqual({
        llmContent: 'This is a small red square image.',
        returnDisplay: 'Image analysis complete for test.png',
      });

      // Verify the prompt used
      expect(mockGenerateContent).toHaveBeenCalledWith(
        [
          {
            role: 'user',
            parts: [
              {
                text: 'Describe this image in detail, including what you see, colors, composition, and any notable elements.',
              },
              mockImageData,
            ],
          },
        ],
        {},
        expect.any(AbortSignal),
      );
    });

    it('should use the correct prompt for plot analysis type', async () => {
      const imagePath = path.join(tempRootDir, 'chart.png');

      // Mock processSingleFileContent to return a successful result
      const mockImageData = {
        inlineData: {
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
          mimeType: 'image/png',
        },
      };

      vi.mocked(processSingleFileContent).mockResolvedValue({
        llmContent: mockImageData,
        returnDisplay: 'Read image file: chart.png',
      });

      // Mock the Gemini client response
      mockGenerateContent.mockResolvedValue({
        text: 'This is a line chart showing increasing data over time.',
      });

      const params: AnalyzeImageToolParams = {
        absolute_path: imagePath,
        analysis_type: 'plot',
      };
      const invocation = tool.build(params) as ToolInvocation<
        AnalyzeImageToolParams,
        ToolResult
      >;

      await invocation.execute(new AbortController().signal);

      // Verify the prompt used
      expect(mockGenerateContent).toHaveBeenCalledWith(
        [
          {
            role: 'user',
            parts: [
              {
                text: 'Analyze this plot/chart. Describe the data visualization type, key insights, trends, and what the data represents.',
              },
              mockImageData,
            ],
          },
        ],
        {},
        expect.any(AbortSignal),
      );
    });

    it('should use general analysis as default when no analysis_type is provided', async () => {
      const imagePath = path.join(tempRootDir, 'image.png');

      // Mock processSingleFileContent to return a successful result
      const mockImageData = {
        inlineData: {
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
          mimeType: 'image/png',
        },
      };

      vi.mocked(processSingleFileContent).mockResolvedValue({
        llmContent: mockImageData,
        returnDisplay: 'Read image file: image.png',
      });

      // Mock the Gemini client response
      mockGenerateContent.mockResolvedValue({
        text: 'This is a general description of the image.',
      });

      const params: AnalyzeImageToolParams = {
        absolute_path: imagePath,
        // No analysis_type provided, should default to 'general'
      };
      const invocation = tool.build(params) as ToolInvocation<
        AnalyzeImageToolParams,
        ToolResult
      >;

      await invocation.execute(new AbortController().signal);

      // Verify the prompt used
      expect(mockGenerateContent).toHaveBeenCalledWith(
        [
          {
            role: 'user',
            parts: [
              {
                text: 'Describe this image in detail, including what you see, colors, composition, and any notable elements.',
              },
              mockImageData,
            ],
          },
        ],
        {},
        expect.any(AbortSignal),
      );
    });
  });
});
