import { reportingSql } from '../server/reporting-db';

async function querySchema() {
  try {
    console.log('Connecting to reporting database...\n');
    
    const tables = [
      'purchase_order_recommendations',
      'purchase_order_recommendation_line_items',
      'purchase_order_calculation_summary',
      'purchase_order_calculation_steps',
      'inventory_forecasts_daily'
    ];
    
    for (const tableName of tables) {
      console.log(`\n========== ${tableName.toUpperCase()} ==========`);
      
      // Get column information
      const columns = await reportingSql`
        SELECT 
          column_name,
          data_type,
          is_nullable,
          column_default,
          character_maximum_length
        FROM information_schema.columns
        WHERE table_name = ${tableName}
        ORDER BY ordinal_position
      `;
      
      console.log('\nColumns:');
      columns.forEach(col => {
        const nullable = col.is_nullable === 'YES' ? 'NULL' : 'NOT NULL';
        const maxLen = col.character_maximum_length ? `(${col.character_maximum_length})` : '';
        console.log(`  - ${col.column_name}: ${col.data_type}${maxLen} ${nullable}`);
        if (col.column_default) {
          console.log(`    DEFAULT: ${col.column_default}`);
        }
      });
      
      // Get sample row count
      const countResult = await reportingSql`
        SELECT COUNT(*) as count FROM ${reportingSql(tableName)}
      `;
      console.log(`\nRow count: ${countResult[0].count}`);
      
      // Get a sample row
      const sampleRows = await reportingSql`
        SELECT * FROM ${reportingSql(tableName)} LIMIT 1
      `;
      
      if (sampleRows.length > 0) {
        console.log('\nSample row:');
        console.log(JSON.stringify(sampleRows[0], null, 2));
      }
    }
    
    await reportingSql.end();
    console.log('\n✓ Schema query completed');
  } catch (error) {
    console.error('Error querying schema:', error);
    process.exit(1);
  }
}

querySchema();
