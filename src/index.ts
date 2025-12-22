import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY') || '';

// MCP Server Implementation
// Follows the Model Context Protocol specification
// https://modelcontextprotocol.io/
// NO AUTHENTICATION REQUIRED - Public endpoint for AI agents

interface MCPRequest {
  jsonrpc: string;
  id: string | number;
  method: string;
  params?: any;
}

interface MCPResponse {
  jsonrpc: string;
  id: string | number;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

// Analyze food from image using OpenAI Vision
async function analyzeFoodImage(imageUrl: string): Promise<any> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Analyze this food image and return ONLY a valid JSON object with these exact fields: name (string), description (string), calories (number), protein (number in grams), fat (number in grams), carbs (number in grams), fiber (number in grams or null), sugar (number in grams or null), sodium (number in mg or null), servingSize (string or null), ingredients (array of strings or null). Return only raw JSON, no markdown.'
            },
            {
              type: 'image_url',
              image_url: { url: imageUrl }
            }
          ]
        }
      ],
      max_tokens: 800
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  
  if (!content) {
    throw new Error('No content in OpenAI response');
  }

  // Clean and parse JSON
  const cleanedContent = content.replace(/```json\n?|```\n?/g, '').trim();
  return JSON.parse(cleanedContent);
}

// Handle MCP protocol requests
function handleMCPRequest(request: MCPRequest): MCPResponse {
  const { jsonrpc, id, method, params } = request;

  // Validate JSON-RPC version
  if (jsonrpc !== '2.0') {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32600,
        message: 'Invalid Request: jsonrpc must be 2.0'
      }
    };
  }

  // Handle different MCP methods
  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: 'food-analyzer-mcp',
            version: '1.0.0'
          }
        }
      };

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'analyze_food_image',
              description: 'Analyzes a food image and returns detailed nutritional information including macros (calories, protein, fat, carbs), micronutrients, and ingredients',
              inputSchema: {
                type: 'object',
                properties: {
                  imageUrl: {
                    type: 'string',
                    description: 'The URL or base64 data URL of the food image to analyze (supports data:image/jpeg;base64,... format)'
                  }
                },
                required: ['imageUrl']
              }
            }
          ]
        }
      };

    case 'tools/call':
      // This is async, so we'll return a promise marker
      return {
        jsonrpc: '2.0',
        id,
        result: {
          _async: true,
          toolName: params?.name,
          arguments: params?.arguments
        }
      };

    default:
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32601,
          message: `Method not found: ${method}`
        }
      };
  }
}

// Main server handler
Deno.serve(async (req) => {
  // Handle CORS - allow all origins
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    });
  }

  try {
    const body = await req.json();
    console.log('📨 Received request:', JSON.stringify(body));

    // Check if this is an MCP request
    if (body.jsonrpc === '2.0') {
      const mcpRequest = body as MCPRequest;
      
      // Handle async tool calls
      if (mcpRequest.method === 'tools/call') {
        const toolName = mcpRequest.params?.name;
        const args = mcpRequest.params?.arguments;

        if (toolName === 'analyze_food_image') {
          try {
            const imageUrl = args?.imageUrl;
            if (!imageUrl) {
              return new Response(JSON.stringify({
                jsonrpc: '2.0',
                id: mcpRequest.id,
                error: {
                  code: -32602,
                  message: 'Invalid params: imageUrl is required'
                }
              }), {
                headers: {
                  'Content-Type': 'application/json',
                  'Access-Control-Allow-Origin': '*'
                }
              });
            }

            console.log('🔍 Analyzing food image...');
            const foodData = await analyzeFoodImage(imageUrl);
            console.log('✅ Analysis complete:', JSON.stringify(foodData));

            return new Response(JSON.stringify({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              result: {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(foodData, null, 2)
                  }
                ],
                isError: false
              }
            }), {
              headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
              }
            });
          } catch (error) {
            console.error('❌ Tool execution error:', error);
            return new Response(JSON.stringify({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              result: {
                content: [
                  {
                    type: 'text',
                    text: `Error analyzing food: ${error.message}`
                  }
                ],
                isError: true
              }
            }), {
              status: 200,
              headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
              }
            });
          }
        }
      }

      // Handle other MCP methods
      const response = handleMCPRequest(mcpRequest);
      return new Response(JSON.stringify(response), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // Non-MCP request (legacy support)
    const { image } = body;
    if (image) {
      const foodData = await analyzeFoodImage(image);
      return new Response(JSON.stringify(foodData), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    return new Response(JSON.stringify({
      error: 'Invalid request format'
    }), {
      status: 400,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });

  } catch (error) {
    console.error('❌ Server error:', error);
    return new Response(JSON.stringify({
      error: 'Internal server error',
      message: error.message
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
});

