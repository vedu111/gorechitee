const { GoogleGenerativeAI } = require('@google/generative-ai');
const dotenv = require('dotenv');

dotenv.config();

// Load precomputed data
const embeddingsDatabase = require('../data/usa-embeddings-database.json');

// Set up Gemini API
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "AIzaSyAGwF77rylskhbDu4WLNf0zSWTuVlNbr5A";
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
const embeddingModel = genAI.getGenerativeModel({ model: "embedding-001" });

// Helper function to check HS code compliance
async function checkHSCodeCompliance(hsCode, embeddingsDatabase) {
  if (embeddingsDatabase.hsCodesData && embeddingsDatabase.hsCodesData[hsCode]) {
    const hsData = embeddingsDatabase.hsCodesData[hsCode];
    return {
      exists: true,
      allowed: hsData.policy && hsData.policy.toLowerCase() === 'free',
      policy: hsData.policy,
      description: hsData.description
    };
  }
  
  if (hsCode && hsCode.length >= 4) {
    const chapter = hsCode.substring(0, 4);
    const twoDigitChapter = hsCode.substring(0, 2);
    
    const matchingCodes = Object.keys(embeddingsDatabase.hsCodesData || {})
      .filter(code => code.startsWith(chapter) || code.startsWith(twoDigitChapter));
    
    if (matchingCodes.length > 0) {
      const policies = matchingCodes.map(code => embeddingsDatabase.hsCodesData[code].policy);
      
      if (policies.some(policy => policy && policy.toLowerCase() === 'free')) {
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
          policy: policies[0] || 'Restricted',
          description: `Falls under chapter ${chapter} which has no free categories`
        };
      }
    }
  }
  
  try {
    const prompt = `Given HS code ${hsCode} that wasn't found in our database, provide a reason why this code might not be recognized for import/export in the USA. Limit your response to one short paragraph.`;
    
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
      reason: `The HS Code ${hsCode} was not found in the USA import/export regulations. Please verify the code and try again.`
    };
  }
}

const usaController = {
  // POST /api/find-by-description
  findByDescription: async (req, res) => {
    try {
      const { description, hsCode } = req.body;
      
      if (!description && !hsCode) {
        return res.status(400).json({ 
          status: false, 
          error: "Missing required fields: provide either description or hsCode" 
        });
      }
      
      // If HS code is provided, check it directly
      if (hsCode) {
        const hsCodeCompliance = await checkHSCodeCompliance(hsCode, embeddingsDatabase);
        
        if (!hsCodeCompliance.exists) {
          return res.json({
            status: false,
            reason: hsCodeCompliance.reason,
            queriedHsCode: hsCode
          });
        }
        
        if (hsCodeCompliance.allowed) {
          return res.json({
            status: true,
            hsCode: hsCode,
            policy: hsCodeCompliance.policy,
            description: hsCodeCompliance.description
          });
        } else {
          return res.json({
            status: false,
            hsCode: hsCode,
            reason: `Import/export not allowed for HS Code ${hsCode} with policy ${hsCodeCompliance.policy || 'Restricted'}`,
            policy: hsCodeCompliance.policy,
            description: hsCodeCompliance.description
          });
        }
      }
      
      // If only description is provided, try to find matching HS code
      const normalizedDescription = description.toLowerCase().trim();
      const hsCodesData = embeddingsDatabase.hsCodesData || {};

      // Ensure hsCodesData has keys to prevent unnecessary lookups
      if (Object.keys(hsCodesData).length === 0) {
        return res.json({ status: false, error: "No HS codes available in the database" });
      }

      // Try exact match first
      let matchingHsCode = Object.keys(hsCodesData).find(hsCode => 
        hsCodesData[hsCode].description && 
        hsCodesData[hsCode].description.toLowerCase() === normalizedDescription
      );

      if (matchingHsCode) {
        const hsCodeCompliance = await checkHSCodeCompliance(matchingHsCode, embeddingsDatabase);
        return res.json({ 
          status: hsCodeCompliance.allowed, 
          hsCode: matchingHsCode,
          policy: hsCodeCompliance.policy,
          description: hsCodeCompliance.description,
          reason: !hsCodeCompliance.allowed ? 
            `Import/export not allowed for HS Code ${matchingHsCode} with policy ${hsCodeCompliance.policy || 'Restricted'}` : 
            undefined
        });
      }

      // If no exact match, try partial match
      let partialMatchHsCode = Object.keys(hsCodesData).find(hsCode => 
        hsCodesData[hsCode].description && (
          hsCodesData[hsCode].description.toLowerCase().includes(normalizedDescription) ||
          normalizedDescription.includes(hsCodesData[hsCode].description.toLowerCase())
        )
      );

      if (partialMatchHsCode) {
        const hsCodeCompliance = await checkHSCodeCompliance(partialMatchHsCode, embeddingsDatabase);
        return res.json({ 
          status: hsCodeCompliance.allowed, 
          hsCode: partialMatchHsCode, 
          note: "Found via partial match",
          policy: hsCodeCompliance.policy,
          description: hsCodeCompliance.description,
          reason: !hsCodeCompliance.allowed ? 
            `Import/export not allowed for HS Code ${partialMatchHsCode} with policy ${hsCodeCompliance.policy || 'Restricted'}` : 
            undefined
        });
      }

      // If no match found, generate AI reason
      try {
        const prompt = `Given the description "${normalizedDescription}" not found in USA import/export regulations, provide a short reason why this item might be restricted.`;
        const result = await model.generateContent({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 100 }
        });

        return res.json({
          status: false,
          reason: result.response.text(),
          queriedDescription: normalizedDescription
        });
      } catch (aiError) {
        console.error('Error generating reason with AI:', aiError);
        return res.json({
          status: false,
          reason: `No matching HS code found for description "${normalizedDescription}". Unable to determine a specific reason due to an AI processing error.`,
          queriedDescription: normalizedDescription
        });
      }

    } catch (error) {
      console.error('Error finding HS code by description:', error);
      return res.status(500).json({ status: false, error: "An error occurred while finding HS code" });
    }
  }
};

module.exports = usaController;
