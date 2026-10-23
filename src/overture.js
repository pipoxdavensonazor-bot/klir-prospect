// Preview adapter: only bounded authenticated RPC responses, never a catalogue URL.
(function(){
  function mapRow(row,sector,result){
    const f=row.feature,p=f.properties||{},a=(p.addresses||[])[0]||{};
    const websites=p.websites||[],phones=p.phones||[],emails=p.emails||[];
    const website=websites.length===1?websites[0]:"";
    return {
      id:"ov_"+f.id,company_name:(p.names||{}).primary||"",industry_key:sector,
      industry:(window.KlirData.INDUSTRIES[sector]||{}).label||sector,
      website:website,domain:"",phone:phones.length===1?phones[0]:"",public_email:emails.length===1?emails[0]:"",
      published_websites:websites,published_phones:phones,published_emails:emails,
      address:a.freeform||"",city:a.locality||"",province:a.region||"",country:a.country||"",postal_code:a.postcode||"",
      geo:{lat:f.geometry.coordinates[1],lon:f.geometry.coordinates[0]},
      source:"Overture Maps",source_url:"https://docs.overturemaps.org/attribution/",overture_id:f.id,
      overture_revision:result.revision||"legacy",overture_release:result.release,overture_version:p.version,source_provenance:p.sources||[],
      source_licenses:[...new Set((p.sources||[]).map(s=>s.license).filter(Boolean))],
      overture_payload_b64:btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(f)))),review:row.review||null,signals:[],employee_range:null,
      website_status:"UNKNOWN",collected_at:result.catalogue_at,last_verified:"",collection_status:result.state,
      field_sources:{published:"Overture "+result.release+" / "+f.id},
      cache_at:result.cache_at
    };
  }
  window.KlirOverture={mapRow};
})();
