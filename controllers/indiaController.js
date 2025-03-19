// controllers/indiaController.js
const { GoogleGenerativeAI } = require('@google/generative-ai');
const dotenv = require('dotenv');
const axios = require('axios');

dotenv.config();

// Load precomputed data
const embeddingsDatabase = require('../data/embeddings-database.json');
const itemToHsMap = require('../data/usa-item-to-hs-mapping.json');

// Set up Gemini API
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "AIzaSyAGwF77rylskhbDu4WLNf0zSWTuVlNbr5A";
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
const embeddingModel = genAI.getGenerativeModel({ model: "embedding-001" });

// Helper function to calculate cosine similarity
function cosineSimilarity(vecA, vecB) {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  
  normA = Math.sqrt(normA);
  normB = Math.sqrt(normB);
  
  return dotProduct / (normA * normB);
}

// Function to find relevant content using embeddings
async function findRelevantContent(query, embeddingsDatabase) {
  try {
    const queryEmbedResult = await embeddingModel.embedContent({
      content: { parts: [{ text: query }] },
    });
    
    const queryEmbedding = queryEmbedResult.embedding.values;
    
    const similarityScores = embeddingsDatabase.chunks.map(item => {
      const similarity = cosineSimilarity(queryEmbedding, item.embedding);
      return { ...item, similarity };
    });
    
    const topResults = similarityScores
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 5);
    
    return topResults.map(item => item.content).join('\n\n');
  } catch (error) {
    console.error('Error finding relevant content:', error);
    throw error;
  }
}

// Function to find HS code by item name
function findHSCodeByItemName(itemName, itemToHsMap) {
  const normalizedItemName = itemName.toLowerCase().trim();
  
  if (itemToHsMap[normalizedItemName]) {
    return itemToHsMap[normalizedItemName];
  }
  
  const itemKeys = Object.keys(itemToHsMap);
  
  const containsMatch = itemKeys.find(key => key.includes(normalizedItemName));
  if (containsMatch) {
    return itemToHsMap[containsMatch];
  }
  
  const isContainedMatch = itemKeys.find(key => normalizedItemName.includes(key) && key.length > 5);
  if (isContainedMatch) {
    return itemToHsMap[isContainedMatch];
  }
  
  return null;
}

// Function to check HS code compliance
async function checkHSCodeCompliance(hsCode, embeddingsDatabase) {
  if (embeddingsDatabase.hsCodesData && embeddingsDatabase.hsCodesData[hsCode]) {
    const hsData = embeddingsDatabase.hsCodesData[hsCode];
    return {
      exists: true,
      allowed: hsData.policy.toLowerCase() === 'free',
      policy: hsData.policy,
      description: hsData.description
    };
  }
  
  if (hsCode.length >= 4) {
    const chapter = hsCode.substring(0, 4);
    const twoDigitChapter = hsCode.substring(0, 2);
    
    const matchingCodes = Object.keys(embeddingsDatabase.hsCodesData || {})
      .filter(code => code.startsWith(chapter) || code.startsWith(twoDigitChapter));
    
    if (matchingCodes.length > 0) {
      const policies = matchingCodes.map(code => embeddingsDatabase.hsCodesData[code].policy);
      
      if (policies.some(policy => policy.toLowerCase() === 'free')) {
        return {
          exists: true,
          allowed: true,
          policy: 'Free',
          description: `Falls under chapter ${chapter} which has some free categories`
        };
      } else {
        return {
          exists: true,
          allowed: false,
          policy: policies[0],
          description: `Falls under chapter ${chapter} which has no free categories`
        };
      }
    }
  }
  
  try {
    const prompt = `Given HS code ${hsCode} that wasn't found in our database, provide a reason why this code might not be recognized. Limit your response to one short paragraph.`;
    
    const result = await model.generateContent({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 100 }
    });
    
    const dynamicReason = result.response.text();
    
    return {
      exists: false,
      allowed: false,
      reason: dynamicReason
    };
  } catch (error) {
    console.error('Error generating dynamic reason:', error);
    return {
      exists: false,
      allowed: false,
      reason: `The HS Code ${hsCode} was not found in the export compliance regulations. Please verify the code and try again.`
    };
  }
}

// Helper function to find HS code by description
function findHSCodeByDescription(description, hsCodesData) {
  const normalizedDescription = description.toLowerCase().trim();
  
  const matchingHsCode = Object.keys(hsCodesData).find(hsCode => 
    hsCodesData[hsCode].description.toLowerCase() === normalizedDescription
  );

  if (matchingHsCode) {
    return matchingHsCode;
  }

  const partialMatchHsCode = Object.keys(hsCodesData).find(hsCode => 
    hsCodesData[hsCode].description.toLowerCase().includes(normalizedDescription) ||
    normalizedDescription.includes(hsCodesData[hsCode].description.toLowerCase())
  );

  return partialMatchHsCode || null;
}

// Controller methods
const indiaController = {
  // POST /api/check-export-compliance
  checkExportCompliance: async (req, res) => {
    try {
      const { hsCode, itemWeight, material, itemName, itemManufacturer, itemDescription } = req.body;
      
      if (!hsCode && !itemName && !itemDescription) {
        return res.status(400).json({
          status: false,
          error: "Missing required fields. Please provide either hsCode, itemName, or itemDescription"
        });
      }
      
      let codeToCheck = hsCode;
      
      if (!hsCode && itemName) {
        codeToCheck = findHSCodeByItemName(itemName, itemToHsMap);
        if (!codeToCheck) {
          return res.json({
            status: false,
            allowed: false,
            reason: `Could not find an HS code matching item name: ${itemName}. Please provide a valid HS code.`
          });
        }
      }

      if (!hsCode && itemDescription) {
        const normalizedDescription = itemDescription.toLowerCase().trim();
        codeToCheck = findHSCodeByDescription(normalizedDescription, embeddingsDatabase.hsCodesData);
        
        if (!codeToCheck) {
          try {
            const prompt = `Given the description "${normalizedDescription}" not found in USA import regulations, provide a short reason why this item is restricted for export.`;
            const result = await model.generateContent({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { maxOutputTokens: 100 }
            });
            
            return res.json({
              status: false,
              allowed: false,
              reason: result.response.text(),
              queriedDescription: normalizedDescription
            });
          } catch (aiError) {
            console.error('Error generating reason with AI:', aiError);
            return res.json({
              status: false,
              allowed: false,
              reason: `No matching HS code found for description "${normalizedDescription}". Unable to determine a specific reason due to an AI processing error.`,
              queriedDescription: normalizedDescription
            });
          }
        }
      }
      
      const hsCodeCompliance = await checkHSCodeCompliance(codeToCheck, embeddingsDatabase);
      
      if (!hsCodeCompliance.exists) {
        return res.json({
          status: false,
          allowed: false,
          reason: hsCodeCompliance.reason,
          queriedHsCode: codeToCheck,
          queriedItemName: itemName || null
        });
      }
      
      if (hsCodeCompliance.allowed) {
        return res.json({
          status: true,
          allowed: true,
          hsCode: codeToCheck,
          policy: hsCodeCompliance.policy,
          description: hsCodeCompliance.description,
          conditions: "Standard export conditions apply",
          queriedItemName: itemName || null
        });
      } else {
        try {
          const prompt = `Given the HS code ${codeToCheck} is not allowed for export, provide a short reason why this item is restricted.`;
          const result = await model.generateContent({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: 100 }
          });
          
          return res.json({
            status: false,
            allowed: false,
            hsCode: codeToCheck,
            policy: hsCodeCompliance.policy,
            description: hsCodeCompliance.description,
            reason: result.response.text(),
            queriedItemName: itemName || null
          });
        } catch (aiError) {
          console.error('Error generating reason with AI:', aiError);
          return res.json({
            status: false,
            allowed: false,
            hsCode: codeToCheck,
            policy: hsCodeCompliance.policy,
            description: hsCodeCompliance.description,
            reason: `Export not allowed for HS Code ${codeToCheck} with policy ${hsCodeCompliance.policy}. Unable to determine a reason due to an AI processing error.`,
            queriedItemName: itemName || null
          });
        }
      }
      
    } catch (error) {
      console.error('Error checking export compliance:', error);
      return res.status(500).json({
        status: false,
        error: "An error occurred while checking export compliance"
      });
    }
  },

  // POST /api/find-by-description
  findByDescription: (req, res) => {
    try {
      const { description } = req.body;
      
      if (!description) {
        return res.status(400).json({
          status: false,
          error: "Missing required field: description"
        });
      }
      
      const normalizedDescription = description.toLowerCase().trim();
      const hsCodesData = embeddingsDatabase.hsCodesData || {};
      
      const matchingHsCode = Object.keys(hsCodesData).find(hsCode => 
        hsCodesData[hsCode].description.toLowerCase() === normalizedDescription
      );
      
      if (matchingHsCode) {
        return res.json({ status: true, hsCode: matchingHsCode });
      }
      
      const partialMatchHsCode = Object.keys(hsCodesData).find(hsCode => 
        hsCodesData[hsCode].description.toLowerCase().includes(normalizedDescription) ||
        normalizedDescription.includes(hsCodesData[hsCode].description.toLowerCase())
      );
      
      if (partialMatchHsCode) {
        return res.json({ status: true, hsCode: partialMatchHsCode, note: "Found via partial match" });
      }
      
      return res.json({ status: false, error: "No matching HS code found for this description" });
      
    } catch (error) {
      console.error('Error finding HS code by description:', error);
      return res.status(500).json({ status: false, error: "An error occurred while finding HS code" });
    }
  }
};

module.exports = indiaController;