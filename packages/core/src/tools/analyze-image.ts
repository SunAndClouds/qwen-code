import path from 'path';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  ToolInvocation,
  ToolResult,
  Kind,
} from './tools.js';
import { processSingleFileContent } from '../utils/fileUtils.js';
import { Config } from '../config/config.js';
import { makeRelative, shortenPath } from '../utils/paths.js';
import { Content, Part } from '@google/genai';
import { SchemaValidator } from '../utils/schemaValidator.js';

export interface AnalyzeImageToolParams {
  absolute_path: string;
  analysis_type?: 'general' | 'plot' | 'diagram' | 'chart';
}

class AnalyzeImageToolInvocation extends BaseToolInvocation<
  AnalyzeImageToolParams,
  ToolResult
> {
  constructor(
    private config: Config,
    params: AnalyzeImageToolParams,
  ) {
    super(params);
  }

  getDescription(): string {
    const relativePath = makeRelative(
      this.params.absolute_path,
      this.config.getTargetDir(),
    );
    return `Analyze image: ${shortenPath(relativePath)}`;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    // Leverage existing file processing infrastructure
    const imageResult = await processSingleFileContent(
      this.params.absolute_path,
      this.config.getTargetDir(),
    );

    if (imageResult.error) {
      return {
        llmContent: `Error: ${imageResult.error}`,
        returnDisplay: `Failed to analyze image: ${imageResult.returnDisplay}`,
      };
    }

    // Prepare content for analysis - separate text and image parts
    const contents: Content[] = [
      {
        role: 'user',
        parts: [
          { text: this.getAnalysisPrompt() },
          imageResult.llmContent as Part, // For images, llmContent is a Part object with inlineData
        ],
      },
    ];

    // Use the Gemini client to generate content
    const response = await this.config.getGeminiClient().generateContent(
      contents,
      {}, // generationConfig
      signal, // abortSignal
    );

    return {
      llmContent: response.text || 'Analysis completed',
      returnDisplay: `Image analysis complete for ${path.basename(this.params.absolute_path)}`,
    };
  }

  private getAnalysisPrompt(): string {
    const prompts = {
      general:
        'Describe this image in detail, including what you see, colors, composition, and any notable elements.',
      plot: 'Analyze this plot/chart. Describe the data visualization type, key insights, trends, and what the data represents.',
      diagram:
        'Analyze this diagram. Explain what it represents, the relationships shown, and the key components.',
      chart:
        'Analyze this chart. Describe the data, comparisons shown, and any insights from the visualization.',
    };

    return prompts[this.params.analysis_type || 'general'];
  }
}

export class AnalyzeImageTool extends BaseDeclarativeTool<
  AnalyzeImageToolParams,
  ToolResult
> {
  static readonly Name = 'analyze_image';

  constructor(private config: Config) {
    super(
      AnalyzeImageTool.Name,
      'AnalyzeImage',
      'Analyze an image file and provide detailed insights about its content',
      Kind.Read,
      {
        properties: {
          absolute_path: {
            type: 'string',
            description: 'The absolute path to the image file to analyze',
          },
          analysis_type: {
            type: 'string',
            enum: ['general', 'plot', 'diagram', 'chart'],
            description: 'Type of analysis to perform',
            default: 'general',
          },
        },
        required: ['absolute_path'],
        type: 'object',
      },
    );
  }

  protected override validateToolParams(
    params: AnalyzeImageToolParams,
  ): string | null {
    const errors = SchemaValidator.validate(
      this.schema.parametersJsonSchema,
      params,
    );
    if (errors) {
      return errors;
    }

    const filePath = params.absolute_path;
    if (!path.isAbsolute(filePath)) {
      return `File path must be absolute, but was relative: ${filePath}. You must provide an absolute path.`;
    }

    const workspaceContext = this.config.getWorkspaceContext();
    if (!workspaceContext.isPathWithinWorkspace(filePath)) {
      const directories = workspaceContext.getDirectories();
      return `File path must be within one of the workspace directories: ${directories.join(', ')}`;
    }

    const fileService = this.config.getFileService();
    if (fileService.shouldGeminiIgnoreFile(params.absolute_path)) {
      return `File path '${filePath}' is ignored by .geminiignore pattern(s).`;
    }

    return null;
  }

  protected createInvocation(
    params: AnalyzeImageToolParams,
  ): ToolInvocation<AnalyzeImageToolParams, ToolResult> {
    return new AnalyzeImageToolInvocation(this.config, params);
  }
}
